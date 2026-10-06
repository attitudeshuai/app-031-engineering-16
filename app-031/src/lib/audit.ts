// 容量核账（本机入口）：100/300/600/1000 件四档，各算一遍排样与刀路，
// 记录每一档的耗时、过程中占住的内存、用板张数、板面利用，
// 再拿事先讲好的上限（src/data/audit-limits.json）逐档卡。
// 同一份单子要过五处互证：排样内核、刀路逐刀模拟、自检断言、统计复核、本机存档；
// 任何两处对不上，在结论里点名是哪一处。超过 1000 件的单子当场回绝（政策与代价见结论）。
// 环境无关：浏览器（首页核账面板）与 Node（scripts/capacity-audit.mjs）共用本模块。
import type { Job, NestResult, Part } from '../types'
import { nestJob } from './packing'
import { simulateWithConservation } from './cuts'
import { reconcileJob } from './selftest'
import limitsData from '../data/audit-limits.json'

// ---------- 对外类型 ----------

export interface AuditCheck {
  name: string
  ok: boolean
  skipped?: boolean // 环境缺探针时记跳过，不算失败
  detail: string
}

export type TierStatus = 'pass' | 'fail' | 'rejected'

export interface TierReport {
  pieces: number // 档位（目标件数）
  bomCount: number // 明细实际件数
  status: TierStatus
  timeMs: number | null // 首遍排样+刀路（null = 本机无计时器）
  timeMsSecond: number | null // 第二遍（稳定性对照）
  simulateMs: number | null // 逐刀守恒模拟耗时
  memoryBytes: number | null // 整档过程占住的堆内存（null = 本机无内存探针）
  boardsUsed: number | null
  utilization: number | null // Σ零件净面积 / Σ板面积
  usedAreaMm2: number | null
  boardAreaMm2: number | null
  placed: number | null
  limitTimeMs: number | null
  limitMemoryBytes: number | null
  overTimeMs: number | null // 超了多少（未超为 null）
  overMemoryBytes: number | null
  skipReason: string | null
  checks: AuditCheck[]
}

export interface AuditReport {
  version: 1
  startedAt: number
  elapsedMs: number
  machine: string
  profile: string
  profileNote: string
  oversizePolicy: string
  maxPieces: number
  tiers: TierReport[]
  crossChecks: AuditCheck[]
  conclusions: string[]
  diffFromPrevious: string[]
  ok: boolean // 跳过不算失败；有档位未过或互证未过为 false
}

/** 存档介质：脚本入口用文件（audit-reports/），浏览器用 localStorage（store.ts）。 */
export interface AuditStorage {
  loadLast(): AuditReport | null
  save(report: AuditReport): void
}

/** 环境探针：内存与机器描述由调用方注入，缺探针的项记跳过而非失败。 */
export interface AuditProbes {
  memoryBytes(): number | null
  gc?: () => void
  machine: string
}

export interface AuditOptions {
  storage?: AuditStorage
  probes?: AuditProbes
  profile?: string // 默认取 audit-limits.json 的 defaultProfile
  seedBase?: number // 默认 20261006；同一档位同一 BOM，跨机可比
}

interface TierLimit {
  pieces: number
  timeMs: number
  memoryMB: number
}

interface LimitProfile {
  note: string
  tiers: TierLimit[]
}

const LIMITS = limitsData as {
  maxPieces: number
  oversizePolicy: string
  defaultProfile: string
  profiles: Record<string, LimitProfile>
}

const BALANCE_TOL_MM2 = 0.5 // 逐刀守恒容差（mm²，浮点噪声远低于此）

// ---------- 环境探针 ----------

export function defaultProbes(): AuditProbes {
  const g = globalThis as {
    process?: { memoryUsage?: () => { heapUsed: number }; versions?: { node?: string }; platform?: string }
    performance?: { memory?: { usedJSHeapSize: number } }
    gc?: () => void
  }
  const memoryBytes = (): number | null => {
    if (g.process?.memoryUsage) return g.process.memoryUsage().heapUsed
    if (g.performance?.memory) return g.performance.memory.usedJSHeapSize
    return null
  }
  const noProbe = !g.process?.memoryUsage && !g.performance?.memory
  const machine = g.process?.versions?.node
    ? `node ${g.process.versions.node} (${g.process.platform ?? '?'})`
    : `浏览器${noProbe ? '（无内存探针）' : ''}`
  return { memoryBytes: noProbe ? () => null : memoryBytes, gc: g.gc, machine }
}

// ---------- 确定性造单 ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TIER_CABINETS = ['客厅柜', '衣柜', '橱柜', '书柜', '玄关柜']

/** 确定性造单：同一档位在任何机器、任何时间生成同一份 BOM，结论才能跨机互比。 */
export function makeTierJob(pieces: number, seed: number): Job {
  const rng = mulberry32(seed)
  const kinds = Math.max(8, Math.min(140, Math.round(pieces / 7.5)))
  const parts: Part[] = []
  let left = pieces
  for (let i = 0; i < kinds && left > 0; i++) {
    const slots = kinds - i
    const avg = left / slots
    const qty =
      i === kinds - 1 ? left : Math.min(left, Math.max(1, Math.round(avg * (0.5 + rng()))))
    left -= qty
    const gr = rng()
    parts.push({
      id: `ap${i}`,
      code: `A${i}`,
      name: `核账件${i}`,
      lenMm: 150 + Math.floor(rng() * 950),
      widMm: 120 + Math.floor(rng() * 580),
      qty,
      grain: gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none',
      edgeBands: rng() < 0.5 ? ['top', 'left'] : [],
      cabinet: TIER_CABINETS[Math.floor(rng() * TIER_CABINETS.length)],
      exposed: rng() < 0.3,
      boardId: ''
    })
  }
  return {
    id: `audit-${pieces}`,
    name: `容量核账 ${pieces} 件`,
    createdAt: 0,
    boards: [
      {
        id: 'audit-board',
        name: '颗粒板 2440×1220×18',
        wMm: 2440,
        hMm: 1220,
        thicknessMm: 18,
        material: '颗粒板',
        priceCents: 13800,
        quantity: 0,
        kind: 'stock'
      }
    ],
    parts: parts.filter((p) => p.qty > 0),
    kerfMm: 3.2,
    trimMm: 8,
    useOffcutIds: [],
    batchByCabinet: false
  }
}

// ---------- 超档政策（两条路只挑一条：当场回绝） ----------

/** 超过 maxPieces 的单子：返回回绝缘由；未超返回 null。砍小续算那条路不取，理由见结论。 */
export function oversizeRejection(pieces: number, maxPieces: number): string | null {
  if (pieces <= maxPieces) return null
  return `超过 ${maxPieces} 件的单子按既定政策当场回绝：不排样、不量数`
}

// ---------- 统计复核（StatsView 口径独立重算） ----------

function statsRecheck(job: Job, r: NestResult): string[] {
  const errs: string[] = []
  const bom = job.parts.reduce((a, p) => a + p.qty, 0)
  const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
  const unplacedQty = r.unplaced.reduce((a, u) => a + u.qty, 0)
  if (placed + unplacedQty !== bom)
    errs.push(`就位 ${placed} + 未排 ${unplacedQty} ≠ 明细 ${bom}`)
  if (r.boardsUsed !== r.sheets.length)
    errs.push(`boardsUsed 报 ${r.boardsUsed}，实际 ${r.sheets.length} 张`)
  const byTypeSum = Object.values(r.boardsByType).reduce((a, n) => a + n, 0)
  if (byTypeSum !== r.sheets.length)
    errs.push(`boardsByType 合计 ${byTypeSum} ≠ 实际板数 ${r.sheets.length}`)
  let net = 0
  let boardArea = 0
  for (const s of r.sheets) {
    const sn = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(sn - s.usedAreaMm2) > 1)
      errs.push(`板${s.index + 1} usedArea ${s.usedAreaMm2} ≠ 零件净面积 ${Math.round(sn)}`)
    if (Math.abs(sn / s.boardAreaMm2 - s.utilization) > 1e-9)
      errs.push(`板${s.index + 1} 利用率复算不符`)
    net += sn
    boardArea += s.boardAreaMm2
  }
  if (boardArea + 1 < net) errs.push(`Σ板面积 ${Math.round(boardArea)} < Σ就位零件净面积 ${Math.round(net)}`)
  let exposed = 0
  let normal = 0
  for (const s of r.sheets) {
    for (const pl of s.placements) {
      const m =
        (pl.origLen *
          ((pl.edgeBands.includes('top') ? 1 : 0) + (pl.edgeBands.includes('bottom') ? 1 : 0)) +
          pl.origWid *
            ((pl.edgeBands.includes('left') ? 1 : 0) + (pl.edgeBands.includes('right') ? 1 : 0))) /
        1000
      if (pl.exposed) exposed += m
      else normal += m
    }
  }
  if (Math.abs(exposed - r.edgeBandM.exposed) > 0.011 || Math.abs(normal - r.edgeBandM.normal) > 0.011)
    errs.push(
      `封边米数复算不符（内核报 见光${r.edgeBandM.exposed}/非见光${r.edgeBandM.normal}，复核 ${exposed.toFixed(2)}/${normal.toFixed(2)}）`
    )
  return errs
}

// ---------- 稳定性签名 ----------

function resultSignature(r: NestResult): unknown {
  return {
    placed: r.sheets.reduce((a, s) => a + s.placements.length, 0),
    boardsUsed: r.boardsUsed,
    edge: r.edgeBandM,
    unplaced: r.unplaced.map((u) => [u.partId, u.qty]),
    sheets: r.sheets.map((s) => ({
      b: s.boardId,
      w: s.wMm,
      h: s.hMm,
      pl: s.placements.map((p) => [p.partId, p.x, p.y, p.lenMm, p.widMm, p.rotated ? 1 : 0]),
      st: s.steps.map((t) => [t.axis, t.at, t.span[0], t.span[1], t.kind])
    }))
  }
}

function firstSigDiff(a: unknown, b: unknown, path: string): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path} 长度 ${a.length} ≠ ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = firstSigDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return `${path} 内容不同`
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
      const d = firstSigDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k
      )
      if (d) return d
    }
    return null
  }
  return `${path}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
}

// ---------- 格式化 ----------

export function fmtBytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function fmtArea(mm2: number): string {
  return `${(mm2 / 1_000_000).toFixed(2)}m²`
}

// ---------- 单档核账 ----------

interface TierVerdicts {
  selftestOk: boolean
  statsOk: boolean
  simOk: boolean
}

function runTier(
  limit: TierLimit,
  seed: number,
  probes: AuditProbes,
  canTime: boolean,
  verdicts: TierVerdicts
): TierReport {
  const pieces = limit.pieces
  const checks: AuditCheck[] = []
  const add = (name: string, ok: boolean, detail: string, skipped = false): void => {
    checks.push({ name, ok: skipped ? true : ok, skipped, detail })
  }
  const report: TierReport = {
    pieces,
    bomCount: pieces,
    status: 'pass',
    timeMs: null,
    timeMsSecond: null,
    simulateMs: null,
    memoryBytes: null,
    boardsUsed: null,
    utilization: null,
    usedAreaMm2: null,
    boardAreaMm2: null,
    placed: null,
    limitTimeMs: limit.timeMs,
    limitMemoryBytes: limit.memoryMB * 1048576,
    overTimeMs: null,
    overMemoryBytes: null,
    skipReason: null,
    checks
  }

  // 超档政策：当场回绝（不排样、不量数）
  const rejection = oversizeRejection(pieces, LIMITS.maxPieces)
  if (rejection) {
    report.status = 'rejected'
    report.skipReason = rejection
    add('超档政策：当场回绝', true, rejection)
    return report
  }

  const job = makeTierJob(pieces, seed)
  const bom = job.parts.reduce((a, p) => a + p.qty, 0)
  report.bomCount = bom
  const now = (): number => (canTime ? performance.now() : 0)

  // —— 第一遍：排样内核 + 刀路生成 ——
  probes.gc?.()
  const mem0 = probes.memoryBytes()
  const t0 = now()
  const r1 = nestJob(job)
  const t1 = now()
  const sims1 = r1.sheets.map((s) =>
    simulateWithConservation(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements)
  )
  const t2 = now()
  // —— 第二遍：同一份单子再算一遍，验证稳定性 ——
  const r2 = nestJob(job)
  const t3 = now()
  const sims2 = r2.sheets.map((s) =>
    simulateWithConservation(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements)
  )
  probes.gc?.()
  const mem1 = probes.memoryBytes()

  if (canTime) {
    report.timeMs = Math.round(t1 - t0)
    report.timeMsSecond = Math.round(t3 - t2)
    report.simulateMs = Math.round(t2 - t1)
  }
  if (mem0 !== null && mem1 !== null) report.memoryBytes = Math.max(0, mem1 - mem0)

  job.result = r1
  const placed = r1.sheets.reduce((a, s) => a + s.placements.length, 0)
  const unplacedQty = r1.unplaced.reduce((a, u) => a + u.qty, 0)
  const usedArea = r1.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const boardArea = r1.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  report.placed = placed
  report.boardsUsed = r1.boardsUsed
  report.usedAreaMm2 = Math.round(usedArea)
  report.boardAreaMm2 = boardArea
  report.utilization = boardArea > 0 ? Math.round((usedArea / boardArea) * 10000) / 10000 : 0

  // 1) 排样内核：就位件数 = 明细件数
  add(
    '排样内核：就位件数 = 明细件数',
    placed === bom && unplacedQty === 0,
    unplacedQty === 0 ? `就位 ${placed}/${bom}` : `就位 ${placed}/${bom}，${unplacedQty} 件未排下`
  )
  // 2) 排样内核：板面积不少于零件面积
  add(
    '排样内核：Σ板面积 ≥ Σ就位零件净面积',
    boardArea + 1 >= usedArea,
    `板面 ${fmtArea(boardArea)} vs 零件净面积 ${fmtArea(usedArea)}`
  )
  // 3) 排样内核自报耗时 vs 脚本入口实测（两处计时互证）
  if (canTime) {
    const selfMs = r1.elapsedMs
    const extMs = t1 - t0
    add(
      '排样内核：自报耗时与入口实测一致',
      Math.abs(selfMs - extMs) <= Math.max(10, extMs * 0.5),
      `内核自报 ${selfMs}ms，入口实测 ${Math.round(extMs)}ms`
    )
  }
  // 4) 刀路逐刀模拟：每块零件按刀序都切得出来
  const simErrors = sims1.flatMap((s, i) => s.errors.map((e) => `板${i + 1}：${e}`))
  verdicts.simOk = simErrors.length === 0
  add(
    '刀路逐刀模拟：每块零件按刀序都切得出来',
    simErrors.length === 0,
    simErrors.length === 0
      ? `${r1.sheets.length} 张板全部还原`
      : simErrors.slice(0, 3).join('；')
  )
  // 5) 刀路逐刀模拟：每一刀面积守恒，终态总账 = 整板
  let worstStep = 0
  let worstAccount = 0
  let missing = 0
  for (const s of sims1) {
    for (const st of s.perStep) worstStep = Math.max(worstStep, Math.abs(st.balanceMm2))
    worstAccount = Math.max(worstAccount, Math.abs(s.account.balanceMm2))
    missing += s.account.partsMissing
  }
  add(
    '刀路逐刀模拟：每一刀零件+余料+锯路 = 整板（不多料不少料）',
    worstStep <= BALANCE_TOL_MM2 && worstAccount <= BALANCE_TOL_MM2 && missing === 0,
    `单刀最大偏差 ${worstStep.toExponential(2)}mm²，终账最大偏差 ${worstAccount.toExponential(2)}mm²（容差 ${BALANCE_TOL_MM2}）`
  )
  // 6) 自检断言复核（selftest 同一套断言）
  const selfErrs = reconcileJob(job)
  verdicts.selftestOk = selfErrs.length === 0
  add(
    '自检断言：selftest 同一套断言复核',
    selfErrs.length === 0,
    selfErrs.length === 0 ? '净距/贯通/模拟/利用率复算全过' : selfErrs.slice(0, 3).join('；')
  )
  // 7) 统计复核（StatsView 口径重算）
  const statErrs = statsRecheck(job, r1)
  verdicts.statsOk = statErrs.length === 0
  add(
    '统计复核：StatsView 口径重算（件数/张数/利用率/封边）',
    statErrs.length === 0,
    statErrs.length === 0 ? '重算与内核报数一致' : statErrs.slice(0, 3).join('；')
  )
  // 8) 稳定性：两遍件数/用板/刀路签名一致
  const sigDiff = firstSigDiff(resultSignature(r1), resultSignature(r2), '')
  add(
    '稳定性：同一份单子算两遍，件数/用板/刀路签名一致',
    sigDiff === null,
    sigDiff === null ? '两遍结果完全一致' : `两遍不一致，先在 ${sigDiff} 对不上`
  )
  // 9) 稳定性：两遍逐刀还原一致
  let simStable = sims1.length === sims2.length
  if (simStable) {
    for (let i = 0; i < sims1.length; i++) {
      const a = sims1[i].account
      const b = sims2[i].account
      if (
        a.partsMatched !== b.partsMatched ||
        a.leavesTotal !== b.leavesTotal ||
        Math.abs(a.kerfMm2 - b.kerfMm2) > BALANCE_TOL_MM2 ||
        Math.abs(a.balanceMm2 - b.balanceMm2) > BALANCE_TOL_MM2
      ) {
        simStable = false
        break
      }
    }
  }
  add(
    '稳定性：两遍逐刀还原一致',
    simStable,
    simStable ? '两遍逐刀账目一致' : '两遍逐刀还原对不上，刀路生成或模拟不稳'
  )
  // 10) 时间上限（无计时器的环境记跳过，不算失败）
  if (canTime && report.timeMs !== null) {
    const over = report.timeMs - limit.timeMs
    report.overTimeMs = over > 0 ? over : null
    add(
      `上限：耗时 ≤ ${limit.timeMs}ms`,
      over <= 0,
      over <= 0 ? `实测 ${report.timeMs}ms` : `实测 ${report.timeMs}ms，超 ${over}ms`
    )
  } else {
    add('上限：耗时', true, '此环境无 performance.now 计时器，时间上限项跳过，不计失败', true)
  }
  // 11) 内存上限（无内存探针的环境记跳过，不算失败）
  if (report.memoryBytes !== null) {
    const over = report.memoryBytes - limit.memoryMB * 1048576
    report.overMemoryBytes = over > 0 ? over : null
    add(
      `上限：内存 ≤ ${limit.memoryMB}MB`,
      over <= 0,
      over <= 0
        ? `实测 ${fmtBytes(report.memoryBytes)}`
        : `实测 ${fmtBytes(report.memoryBytes)}，超 ${fmtBytes(over)}`
    )
  } else {
    add(
      '上限：内存',
      true,
      '此环境无内存探针（非 Node、非 Chromium），内存上限项跳过，不计失败',
      true
    )
  }

  report.status = checks.some((c) => !c.ok && !c.skipped) ? 'fail' : 'pass'
  return report
}

// ---------- 与上一回比 ----------

export function diffAuditReports(prev: AuditReport | null, next: AuditReport): string[] {
  if (!prev) return ['首次核账，本机没有上一回结论可比']
  const out: string[] = []
  if (prev.profile !== next.profile)
    out.push(`限值口径变了（${prev.profile} → ${next.profile}）：两回结论不能并排比`)
  if (prev.oversizePolicy !== next.oversizePolicy || prev.maxPieces !== next.maxPieces)
    out.push(`超档政策变了（>${prev.maxPieces} ${prev.oversizePolicy} → >${next.maxPieces} ${next.oversizePolicy}）：以往对照数作废`)
  for (const t of next.tiers) {
    const p = prev.tiers.find((x) => x.pieces === t.pieces)
    if (!p) {
      out.push(`新增档位 ${t.pieces} 件：${t.status}`)
      continue
    }
    if (p.status !== t.status) out.push(`${t.pieces} 件档判定变了：${p.status} → ${t.status}`)
    if (p.timeMs !== null && t.timeMs !== null) {
      const d = t.timeMs - p.timeMs
      if (Math.abs(d) >= 20) out.push(`${t.pieces} 件档耗时 ${d > 0 ? '+' : ''}${d}ms（${p.timeMs} → ${t.timeMs}）`)
    }
    if (p.memoryBytes !== null && t.memoryBytes !== null) {
      const d = t.memoryBytes - p.memoryBytes
      if (Math.abs(d) >= 4 * 1048576)
        out.push(`${t.pieces} 件档内存 ${d > 0 ? '+' : ''}${fmtBytes(d)}（${fmtBytes(p.memoryBytes)} → ${fmtBytes(t.memoryBytes)}）`)
    }
    if (p.boardsUsed !== null && t.boardsUsed !== null && p.boardsUsed !== t.boardsUsed)
      out.push(`${t.pieces} 件档用板 ${p.boardsUsed} → ${t.boardsUsed} 张`)
  }
  for (const p of prev.tiers) {
    if (!next.tiers.some((x) => x.pieces === p.pieces)) out.push(`档位消失：${p.pieces} 件`)
  }
  const checkNames = (r: AuditReport): Set<string> =>
    new Set([...r.crossChecks.map((c) => c.name), ...r.tiers.flatMap((t) => t.checks.map((c) => c.name))])
  const prevNames = checkNames(prev)
  const nextNames = checkNames(next)
  const added = [...nextNames].filter((n) => !prevNames.has(n))
  const removed = [...prevNames].filter((n) => !nextNames.has(n))
  if (added.length > 0) out.push(`新增检查项：${added.join('、')}`)
  if (removed.length > 0) out.push(`减少检查项：${removed.join('、')}`)
  if (out.length === 0) out.push('与上一回结论一致（判定、耗时、内存、用板均无可见变化）')
  return out
}

// ---------- 结论文案 ----------

function oversizeConclusion(maxPieces: number): string {
  return (
    `超档政策（>${maxPieces} 件）：选「当场回绝」——这样的单子不排样、不量数，直接回绝。` +
    `代价已认：超过 ${maxPieces} 件的单子这条入口永远量不到，车间拿不到该档的耗时与内存数。` +
    `没选的那条路是「按规模砍小了接着算」：那样量出的结论与真实规模对不上，砍小档的结论不能与既有档位并排比较，` +
    `以前攒下的对照数也跟着作废——故不取。应用本身对超千件也是显式提示而非硬算（规格书 §12），两处口径一致。`
  )
}

function profileConclusion(profile: string): string {
  if (profile === 'workshop') {
    return (
      `上限口径：限值按「车间机器」定档（假设车间机 ≈ 本机 1/3 速度、堆内存预算 512MB，写在 src/data/audit-limits.json）。` +
      `代价已认：本机跑出的余量会很大，全绿不等于车间够用；若车间实机比假设更弱，限值就太松、该拦的拦不住，` +
      `上线后会在车间机器上先崩——车间实机到位后必须重跑本入口复核，口径一变，以往攒下的对照数不能并排比。` +
      `没选的那条路是「按开发机定」：限值紧、回归拦得严、本机日常跑得快，但那是这台机器的口径，` +
      `车间机更弱时过了关照样崩，且为过紧限值可能被迫把认证规模压小。日常快筛可用 FCO_AUDIT_PROFILE=dev 切开发机口径。`
    )
  }
  return (
    `上限口径：限值按「开发机」定档（约为本机实测的 3 倍，写在 src/data/audit-limits.json）。` +
    `代价已认：这只是这台机器的口径，车间机更弱时，过了关也可能在车间崩；为卡紧限值，认证规模可能被压小。` +
    `没选的那条路是「按车间机器定」：限值松、贴近生产，但本机日常跑余量虚高、全绿不代表车间够用。`
  )
}

// ---------- 主入口 ----------

export function runCapacityAudit(opts: AuditOptions = {}): AuditReport {
  const startedAt = Date.now()
  const canTime =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
  const clock = (): number => (canTime ? performance.now() : 0)
  const t0 = clock()
  const probes = opts.probes ?? defaultProbes()
  const profileName = opts.profile ?? LIMITS.defaultProfile
  const profile = LIMITS.profiles[profileName]
  const seedBase = opts.seedBase ?? 20261006

  const crossChecks: AuditCheck[] = []
  const addCross = (name: string, ok: boolean, detail: string, skipped = false): void => {
    crossChecks.push({ name, ok: skipped ? true : ok, skipped, detail })
  }

  // 互证 0：核账口径配置完整（事先讲好的上限必须四档递增、限值为正）
  const configErrs: string[] = []
  if (!profile) configErrs.push(`口径 ${profileName} 不存在`)
  if (LIMITS.maxPieces !== 1000) configErrs.push(`maxPieces=${LIMITS.maxPieces}，应为 1000（与应用口径一致）`)
  if (LIMITS.oversizePolicy !== 'reject') configErrs.push(`oversizePolicy=${LIMITS.oversizePolicy}，应为 reject`)
  if (profile) {
    const ps = profile.tiers.map((t) => t.pieces)
    const want = [100, 300, 600, 1000]
    if (ps.join(',') !== want.join(',')) configErrs.push(`档位应为 ${want.join('/')}，实为 ${ps.join('/')}`)
    for (const t of profile.tiers) {
      if (!(t.timeMs > 0) || !(t.memoryMB > 0)) configErrs.push(`${t.pieces} 件档限值非正数`)
    }
  }
  addCross(
    '核账口径：上限配置完整（四档、限值为正、政策=回绝）',
    configErrs.length === 0,
    configErrs.length === 0 ? `口径=${profileName}，档位 100/300/600/1000` : configErrs.join('；')
  )

  // 四档各算一遍
  const tiers: TierReport[] = []
  const verdictsByTier = new Map<number, TierVerdicts>()
  if (profile) {
    for (const limit of profile.tiers) {
      const verdicts: TierVerdicts = { selftestOk: true, statsOk: true, simOk: true }
      const tier = runTier(limit, seedBase + limit.pieces, probes, canTime, verdicts)
      verdictsByTier.set(limit.pieces, verdicts)
      tiers.push(tier)
    }
  }

  // 互证 1：超档政策生效（探针单 maxPieces+200 件必须被回绝，maxPieces 件放行）
  const probePieces = LIMITS.maxPieces + 200
  const rejected = oversizeRejection(probePieces, LIMITS.maxPieces)
  const allowed = oversizeRejection(LIMITS.maxPieces, LIMITS.maxPieces)
  addCross(
    `超档政策：>${LIMITS.maxPieces} 件当场回绝`,
    rejected !== null && allowed === null,
    rejected !== null && allowed === null
      ? `探针 ${probePieces} 件被回绝（${rejected}），${LIMITS.maxPieces} 件放行`
      : '超档政策未按预期生效'
  )

  // 互证 2：自检断言 / 统计复核 / 逐刀模拟三处结论一致，对不上就点名
  const disagree: string[] = []
  for (const [pieces, v] of verdictsByTier) {
    const flags = [
      ['自检断言', v.selftestOk],
      ['统计复核', v.statsOk],
      ['逐刀模拟', v.simOk]
    ] as const
    const bad = flags.filter(([, ok]) => !ok).map(([n]) => n)
    const good = flags.filter(([, ok]) => ok).map(([n]) => n)
    if (bad.length > 0 && good.length > 0) {
      disagree.push(`${pieces} 件档：${bad.join('、')} 报错，但 ${good.join('、')} 全过`)
    }
  }
  addCross(
    '互证：自检断言 / 统计复核 / 逐刀模拟三处结论一致',
    disagree.length === 0,
    disagree.length === 0 ? '三处对同一份单子的判定一致' : disagree.join('；')
  )

  // 结论
  const conclusions: string[] = []
  conclusions.push(`本机：${probes.machine}；核账口径=${profileName}（${profile?.note ?? '无'}）`)
  for (const t of tiers) {
    if (t.status === 'rejected') {
      conclusions.push(`${t.pieces} 件档：回绝 —— ${t.skipReason}`)
      continue
    }
    const timeText =
      t.timeMs !== null ? `排样+刀路 ${t.timeMs}ms（上限 ${t.limitTimeMs}ms）` : '无计时'
    const memText =
      t.memoryBytes !== null
        ? `内存 ${fmtBytes(t.memoryBytes)}（上限 ${fmtBytes(t.limitMemoryBytes ?? 0)}）`
        : '内存无探针'
    const useText = `用板 ${t.boardsUsed} 张、板面利用 ${((t.utilization ?? 0) * 100).toFixed(1)}%（${fmtArea(t.usedAreaMm2 ?? 0)}/${fmtArea(t.boardAreaMm2 ?? 0)}）`
    if (t.status === 'fail') {
      const overs: string[] = []
      if (t.overTimeMs !== null) overs.push(`耗时超 ${t.overTimeMs}ms`)
      if (t.overMemoryBytes !== null) overs.push(`内存超 ${fmtBytes(t.overMemoryBytes)}`)
      const badChecks = t.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name)
      conclusions.push(
        `${t.pieces} 件档：未过 —— ${overs.length > 0 ? overs.join('、') : '对账未过'}；${timeText}，${memText}，${useText}；卡在：${badChecks.join('；')}`
      )
    } else {
      conclusions.push(`${t.pieces} 件档：通过 —— ${timeText}，${memText}，${useText}`)
    }
  }
  for (const t of tiers) {
    for (const c of t.checks) {
      if (c.skipped) conclusions.push(`跳过说明（${t.pieces} 件档「${c.name}」）：${c.detail}`)
    }
  }
  if (!probes.gc) {
    conclusions.push('内存数为含 GC 噪声的近似值（Node 加 --expose-gc 可测准）；内存上限判定仍生效。')
  }
  conclusions.push(oversizeConclusion(LIMITS.maxPieces))
  conclusions.push(profileConclusion(profileName))

  const elapsedMs = Math.round(clock() - t0)
  const baseOk =
    tiers.every((t) => t.status !== 'fail') && crossChecks.every((c) => c.ok || c.skipped)

  const report: AuditReport = {
    version: 1,
    startedAt,
    elapsedMs,
    machine: probes.machine,
    profile: profileName,
    profileNote: profile?.note ?? '',
    oversizePolicy: LIMITS.oversizePolicy,
    maxPieces: LIMITS.maxPieces,
    tiers,
    crossChecks,
    conclusions,
    diffFromPrevious: [],
    ok: baseOk
  }

  // 本机存档：写入后回读互证；再与上一回比出多了什么、少了什么；最终版落盘
  const storage = opts.storage
  if (storage) {
    let prev: AuditReport | null = null
    try {
      prev = storage.loadLast()
    } catch {
      prev = null
    }
    try {
      storage.save(report)
      const back = storage.loadLast()
      const roundTrip = back !== null && JSON.stringify(back) === JSON.stringify(report)
      report.crossChecks.push({
        name: '本机存档：报告写入后回读一致',
        ok: roundTrip,
        detail: roundTrip ? '存档回读与内存结论逐字节一致' : '存档回读与内存结论对不上——本机存档这一处有问题'
      })
      if (!roundTrip) report.ok = false
    } catch (err) {
      report.crossChecks.push({
        name: '本机存档：报告写入后回读一致',
        ok: false,
        detail: `存档读写失败：${err instanceof Error ? err.message : String(err)}`
      })
      report.ok = false
    }
    // diff 放在存档互证之后：上一回与本回的检查项集合才同口径，不会虚报「减少检查项」
    report.diffFromPrevious = diffAuditReports(prev, report)
    try {
      storage.save(report) // 把含存档互证与 diff 的最终版再落一份
    } catch {
      // 第二次写入失败不推翻已验证过的回读结论，但要在互证里留痕
      const c = report.crossChecks.find((x) => x.name === '本机存档：报告写入后回读一致')
      if (c) c.detail += '（最终版二次写入失败，latest 为上一版）'
    }
  } else {
    report.diffFromPrevious = diffAuditReports(null, report)
    report.crossChecks.push({
      name: '本机存档：报告写入后回读一致',
      ok: true,
      skipped: true,
      detail: '未提供存档介质（内存运行），存档互证跳过，不计失败'
    })
  }

  return report
}
