#!/usr/bin/env node
// 核账入口（本机）：四个档位各算一遍排样与刀路，量时间与内存、对账、
// 拿事先讲好的上限去卡，结论存本机 bench/ 并能跟上一回比出多了什么、少了什么。
//
// 用法：
//   npm run audit                  # 跑固定四档 100/300/600/1000
//   npm run audit -- --size=600    # 只跑某一档（可逗号分隔多档）
//   npm run audit -- --size=1600   # 超过 1000 件：按既定取舍当场回绝
//
// 机器上没装该有的运行环境（依赖没装、上限文件缺失、GC 未暴露）时，
// 对应项记「跳过」并写明缘由，不记成没过。
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import process from 'node:process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const benchDir = resolve(appRoot, 'bench')
const limitsPath = resolve(appRoot, 'scripts', 'audit.limits.json')
const bundlePath = resolve(appRoot, 'node_modules', '.cache', 'fco-audit', 'audit.mjs')

const KEEP_ARCHIVES = 50

function writeArchive(record) {
  try {
    mkdirSync(benchDir, { recursive: true })
    const stamp = record.startedAt.replace(/[:.]/g, '-')
    writeFileSync(resolve(benchDir, `audit-${stamp}.json`), JSON.stringify(record, null, 2))
    // 跳过/纯回绝的记录只留档、不顶掉 latest.json：上一回对比要对着最近一份有实测档位的结论
    const hasMeasured = (record.tiers ?? []).some((t) => t.status === 'pass' || t.status === 'fail')
    if (record.status !== 'skipped' && hasMeasured) {
      writeFileSync(resolve(benchDir, 'latest.json'), JSON.stringify(record, null, 2))
    }
    // 只留最近 KEEP_ARCHIVES 份，防止存档无限涨
    const files = readdirSync(benchDir)
      .filter((f) => /^audit-.*\.json$/.test(f))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_ARCHIVES))) {
      try {
        unlinkSync(resolve(benchDir, f))
      } catch {
        /* 删不动就留着 */
      }
    }
    return null
  } catch (e) {
    return `本机存档写不进去（${String(e)}），这回的结论只打在屏幕上`
  }
}

function readPrevious() {
  try {
    const raw = readFileSync(resolve(benchDir, 'latest.json'), 'utf8')
    const obj = JSON.parse(raw)
    if (obj && obj.tool === 'fco-audit' && Array.isArray(obj.tiers)) return obj
    return null
  } catch {
    return null
  }
}

function parseSizes(argv) {
  const arg = argv.find((a) => a.startsWith('--size='))
  if (!arg) return undefined
  const sizes = arg
    .slice('--size='.length)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n))
  return sizes.length > 0 ? sizes : undefined
}

async function main() {
  const startedAt = new Date().toISOString()
  const sizes = parseSizes(process.argv.slice(2))

  // —— 环境检查一：构建依赖（esbuild）在不在 ——
  let esbuild = null
  try {
    esbuild = await import('esbuild')
  } catch {
    esbuild = null
  }
  if (!esbuild || !existsSync(resolve(appRoot, 'node_modules'))) {
    const record = {
      tool: 'fco-audit',
      version: 1,
      startedAt,
      status: 'skipped',
      reasons: [
        '本机没装运行环境（node_modules 缺失或 esbuild 不可用），核账整体跳过；' +
          '先跑 npm ci 再 npm run audit。跳过不记没过。'
      ]
    }
    const archiveErr = writeArchive(record)
    console.log('开料核账：跳过（环境没装齐）')
    for (const r of record.reasons) console.log(`  缘由：${r}`)
    if (archiveErr) console.log(`  存档：${archiveErr}`)
    process.exit(0)
  }

  // —— 打包核账核心（src/lib/audit.ts 及其依赖的既有部件）——
  mkdirSync(dirname(bundlePath), { recursive: true })
  await esbuild.build({
    entryPoints: [resolve(appRoot, 'src', 'lib', 'audit.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent'
  })
  const core = await import(pathToFileURL(bundlePath).href)

  // —— 环境检查二：事先讲好的上限文件 ——
  let limits = null
  try {
    limits = JSON.parse(readFileSync(limitsPath, 'utf8'))
  } catch {
    console.log(`提示：上限文件 scripts/audit.limits.json 缺失或损坏，本次只测量不卡线（记跳过，不记没过）`)
  }

  // —— 内存/时间探针（GC 未暴露时对应测量自动跳过）——
  const gcExposed = typeof globalThis.gc === 'function'
  const mem = {
    heapMB: () => process.memoryUsage().heapUsed / 1048576,
    rssMB: () => process.memoryUsage().rss / 1048576,
    maxRssMB: () => process.resourceUsage().maxRSS / 1024,
    gc: gcExposed ? () => globalThis.gc() : undefined
  }
  const cpus = os.cpus()
  const env = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? '未知',
    cpuCount: cpus.length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    gcExposed
  }

  const previous = readPrevious()
  const report = core.runAudit({ limits, env, mem, sizes, previous, nowIso: startedAt })

  const archiveErr = writeArchive(report)
  console.log(report.conclusion.join('\n'))
  if (archiveErr) console.log(`存档：${archiveErr}（跳过，不记没过）`)
  else console.log(`存档：已存 bench/（共留最近 ${KEEP_ARCHIVES} 份，latest.json 为最新）`)
  process.exit(report.verdict.ok ? 0 : 1)
}

main().catch((e) => {
  console.error('核账入口自身出错：', e)
  process.exit(2)
})
