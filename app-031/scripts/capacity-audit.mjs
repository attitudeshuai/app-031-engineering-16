#!/usr/bin/env node
// 容量核账 · 脚本入口（npm run audit）
// 用 esbuild 把 src/lib/audit.ts（连同排样内核、刀路逐刀模拟、自检断言）打成临时 bundle
// 后在 Node 里跑：四档各算一遍排样与刀路 → 五处互证对账 → 上限卡档 →
// 结论存 audit-reports/ 并与上一回比出多了什么、少了什么。
// 退出码：0 全过（环境缺探针的跳过项不算失败）；1 有档位/互证未过；2 脚本入口自身故障。
import { buildSync } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP_REPORTS = 20

// ---------- 打包并加载核账模块 ----------
let audit
try {
  const cacheDir = join(root, 'node_modules', '.cache', 'fco-audit')
  mkdirSync(cacheDir, { recursive: true })
  const bundle = join(cacheDir, 'audit.bundle.mjs')
  buildSync({
    entryPoints: [join(root, 'src', 'lib', 'audit.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundle,
    logLevel: 'warning'
  })
  audit = await import(pathToFileURL(bundle).href)
} catch (err) {
  console.error('[核账] 脚本入口自身故障：核账模块打包/加载失败（这不记为档位未过，是入口坏了）')
  console.error(err)
  process.exit(2)
}

// ---------- 本机存档：audit-reports/（留最近 20 份 + latest.json） ----------
const reportsDir = join(root, 'audit-reports')
mkdirSync(reportsDir, { recursive: true })
const storage = {
  loadLast() {
    const latest = join(reportsDir, 'latest.json')
    if (!existsSync(latest)) return null
    try {
      return JSON.parse(readFileSync(latest, 'utf8'))
    } catch {
      return null
    }
  },
  save(report) {
    const stamp = new Date(report.startedAt).toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(reportsDir, `capacity-audit-${stamp}.json`), JSON.stringify(report, null, 2))
    writeFileSync(join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2))
    const files = readdirSync(reportsDir)
      .filter((f) => f.startsWith('capacity-audit-'))
      .sort()
    while (files.length > KEEP_REPORTS) unlinkSync(join(reportsDir, files.shift()))
  }
}

// ---------- 环境探针（缺探针的项由核账核心记跳过，不算失败） ----------
const hasGc = typeof globalThis.gc === 'function'
const probes = {
  memoryBytes: () => process.memoryUsage().heapUsed,
  gc: hasGc ? () => globalThis.gc() : undefined,
  machine:
    `node ${process.version} ${process.platform}/${process.arch} · ` +
    `${os.cpus()[0]?.model ?? '未知CPU'} ×${os.cpus().length} · 总内存 ${Math.round(os.totalmem() / 1073741824)}GB` +
    (hasGc ? '' : ' · 未加 --expose-gc（内存为近似值）')
}

const profile = process.env.FCO_AUDIT_PROFILE || undefined
const report = audit.runCapacityAudit({ storage, probes, profile })

// ---------- 打印 ----------
const STATUS_TEXT = { pass: '通过', fail: '未过', rejected: '回绝' }
const line = (s = '') => console.log(s)

line(`容量核账 · ${new Date(report.startedAt).toLocaleString('zh-CN')}`)
line(`机器：${report.machine}`)
line(`口径：${report.profile} · 超档政策：>${report.maxPieces} 件 ${report.oversizePolicy} · 总耗时 ${report.elapsedMs}ms`)
line('')
for (const t of report.tiers) {
  const head = `[${String(t.pieces).padStart(4)} 件] ${STATUS_TEXT[t.status]}`
  if (t.status === 'rejected') {
    line(`${head} —— ${t.skipReason}`)
    continue
  }
  const time = t.timeMs === null ? '无计时' : `${t.timeMs}ms / 上限 ${t.limitTimeMs}ms`
  const mem =
    t.memoryBytes === null
      ? '无探针'
      : `${audit.fmtBytes(t.memoryBytes)} / 上限 ${audit.fmtBytes(t.limitMemoryBytes ?? 0)}`
  line(
    `${head}  排样+刀路 ${time} · 内存 ${mem} · 用板 ${t.boardsUsed} 张 · 板面利用 ${((t.utilization ?? 0) * 100).toFixed(1)}%`
  )
  const bad = t.checks.filter((c) => !c.ok && !c.skipped)
  const skipped = t.checks.filter((c) => c.skipped)
  const passed = t.checks.length - bad.length - skipped.length
  line(`         对账 ${passed}/${t.checks.length - skipped.length} 项过${skipped.length > 0 ? `，${skipped.length} 项跳过` : ''}`)
  for (const c of bad) line(`         ✗ ${c.name} —— ${c.detail}`)
  for (const c of skipped) line(`         ⏭ ${c.name} —— ${c.detail}`)
}
line('')
line('互证（排样内核 / 刀路逐刀模拟 / 自检断言 / 统计复核 / 本机存档）：')
for (const c of report.crossChecks) {
  line(`  ${c.skipped ? '⏭' : c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` —— ${c.detail}` : ''}`)
}
line('')
line('与上一回比：')
for (const d of report.diffFromPrevious) line(`  · ${d}`)
line('')
line('结论：')
for (const c of report.conclusions) line(`  ${c}`)
line('')
line(`报告已存 ${relative(process.cwd(), join(reportsDir, 'latest.json'))}（留最近 ${KEEP_REPORTS} 份）`)
process.exit(report.ok ? 0 : 1)
