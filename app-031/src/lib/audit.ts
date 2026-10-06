// 核账（audit）核心：四个档位（100/300/600/1000 件）各算一遍排样与刀路，
// 量每一档花的时间、过程中占住的堆内存、用掉几张板、板面用掉多少；
// 每一档顺带对账（件数守恒、面积守恒、逐刀模拟还原、逐刀守恒、同一单算两遍一致），
// 再拿事先讲好的时间与内存上限去卡，哪一档没过、超了多少，直接写进结论。
//
// 同一份单子的结论横跨几处既有部件，互相印证，对不上就点名：
//   排样内核（packing.nestJob）/ 刀路与逐刀模拟（cuts.simulate、cuts.auditCutBalance）
//   / 自检与统计（selftest.verifyNestJob、统计复算）/ 本机存档（上一回报告对比）。
//
// 本文件环境无关：内存/时间探针由入口注入（Node 入口见 scripts/run-audit.mjs），
// 不碰 fs / localStorage，浏览器侧将来也可以复用。
import type { Job, NestResult, Part } from '../types'
import { nestJob } from './packing'
import { auditCutBalance, countSawOps, simulate } from './cuts'
import { mulberry32, runSelfTest, verifyNestJob } from './selftest'
import type { CheckResult } from './selftest'

// ---------------------------------------------------------------------------
// 档位与上限

/** 固定四个档位（件）。 */
export const AUDIT_TIERS = [100, 300, 600, 1000] as const

/** 支持规模上限：超过即按既定取舍当场回绝（见 POLICY_TEXT）。 */
export const MAX_TIER_SIZE = 1000

/** 单档上限：时间（排样+刀路一遍）与堆内存增量。 */
export interface TierLimit {
  maxMs: number
  maxHeapMB: number
}

export interface AuditLimits {
  /** 上限口径：workshop = 按车间机器定（本仓库的既定取舍）。 */
  basis: string
  note?: string
  tiers: Record<string, TierLimit>
}

// ---------------------------------------------------------------------------
// 探针与环境（由入口注入）

export interface MemProbe {
  /** 当前堆占用 MB；环境给不出就返回 null（对应项记跳过，不记没过）。 */
  heapMB(): number | null
  rssMB?(): number | null
  maxRssMB?(): number | null
  /** 强制 GC（如 node --expose-gc）；没有它，驻留堆测量跳过并写明缘由。 */
  gc?(): void
}

export interface AuditEnv {
  node?: string
  platform: string
  arch: string
  cpuModel: string
  cpuCount: number
  totalMemMB: number
  gcExposed: boolean
}

// ---------------------------------------------------------------------------
// 报告模型

export interface TierMeasure {
  nestMs: number // 排样+刀路一遍（被上限卡的口径）
  secondNestMs: number // 同一单第二遍（稳定性参照）
  reconcileMs: number // 对账耗时（逐刀模拟+守恒+自检，不进上限）
  heapBeforeMB: number | null
  heapPeakMB: number | null
  heapDeltaMB: number | null
  retainedMB: number | null // GC 后驻留；无 gc 探针时为 null
  rssPeakMB: number | null
}

export interface TierAccount {
  manifestQty: number // 明细件数
  placed: number // 排下去的件数
  unplaced: number
  boardsUsed: number // 用板张数
  boardAreaM2: number
  partAreaM2: number
  utilization: number // 板面用掉多少（Σ零件净面积 / Σ板面积）
  sawOps: number // 车间锯切工步数（修边叠切合并）
  stepsTotal: number // 刀路总步数
  edgeBandM: { exposed: number; normal: number }
  usableOffcuts: number
}

export interface TierGate {
  maxMs: number
  maxHeapMB: number
  timeOk: boolean
  memOk: boolean
  timeOverMs: number // 超了多少（0 = 没超）
  memOverMB: number
}

export interface TierAudit {
  size: number
  status: 'pass' | 'fail' | 'skipped' | 'rejected'
  reason?: string // skipped / rejected 的缘由
  seed?: number
  kinds?: number
  measure?: TierMeasure
  account?: TierAccount
  reconcile?: CheckResult[] // 对账：守恒/还原/两遍一致
  crossCheck?: CheckResult[] // 互相印证：几处部件的结论对账
  determinism?: { ok: boolean; detail: string }
  gate?: TierGate
  skips?: string[] // 本档被跳过的测量与缘由（不记没过）
}

export interface AuditDiff {
  hasPrevious: boolean
  added: string[]
  removed: string[]
  changed: string[]
}

export interface AuditReport {
  tool: 'fco-audit'
  version: 1
  startedAt: string
  elapsedMs: number
  env: AuditEnv & { fingerprint: string }
  generator: { version: number; seedBase: number }
  policy: { oversize: 'reject'; limitsBasis: 'workshop'; text: string[] }
  limits: AuditLimits | null
  tiers: TierAudit[]
  selftestSuite: CheckResult | null // 自检套件（100 组随机断言）在本机的结论
  verdict: { ok: boolean; failed: string[]; skipped: string[]; rejected: string[] }
  diff: AuditDiff
  conclusion: string[]
}

export interface AuditOptions {
  limits: AuditLimits | null // null = 上限文件缺失：测量照跑，卡线跳过并写明缘由
  env: AuditEnv
  mem: MemProbe
  sizes?: number[]
  previous?: AuditReport | null
  nowIso?: string
}

// ---------------------------------------------------------------------------
// 既定取舍（两条路都能走，各认各的代价；这里讲明选了哪条、放弃了什么）

export const POLICY_TEXT: string[] = [
  '取舍一 · 超过 1000 件的单子：当场回绝，不按规模砍小了接着算。',
  '  选回绝认下的代价：这样的单子在本机量不到数，车间拿不到这档的对照数据，',
  '  要接只能拆成 ≤1000 件的子单分别算（与应用支持的规模口径一致）。',
  '  放弃的另一条路（砍小）：量出的是缩小后的结论，跟真实规模对不上，',
  '  两种口径的结论不能摆在一起比，以前攒下的各组对照数也跟着作废。',
  '取舍二 · 时间与内存上限：按车间那台机器定，不按本机（开发机）定。',
  '  按车间机器定认下的代价：本机每跑一遍要占更多内存、花更多时间，',
  '  日常容易没人愿意跑——靠一条命令（npm run audit）加存档对比把门槛压低。',
  '  放弃的另一条路（按开发机定）：本机跑得轻快，但只能证明开发机装得下、',
  '  装得下的件数更少；超出的部分没被套进验证，上线后容易先在车间的机器上崩。'
]

// ---------------------------------------------------------------------------
// 单子生成（确定性：同种子同单，换机可复现）

const GEN_VERSION = 1
const SEED_BASE = 20261006

const CABINETS = ['地柜', '吊柜', '衣柜', '书柜', '橱柜', '玄关柜', '阳台柜', '榻榻米']
const EDGE_PRESETS: Part['edgeBands'][] = [
  ['top', 'left'],
  ['left', 'right'],
  ['top', 'bottom'],
  ['top', 'bottom', 'left', 'right']
]

/** 生成某一档的测试单：kinds 种规格、总数恰好 size 件；同 seed 必得同单。 */
export function generateTierJob(size: number, seed: number): Job {
  const rng = mulberry32(seed)
  const kinds = Math.min(60, Math.max(10, Math.round(size / 12)))
  const avg = size / kinds
  const parts: Part[] = []
  let total = 0
  for (let i = 0; i < kinds; i++) {
    const qty = Math.max(1, Math.round(avg * (0.5 + rng())))
    const gr = rng()
    const grain: Part['grain'] = gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none'
    const edgeBands = rng() < 0.5 ? [] : EDGE_PRESETS[Math.floor(rng() * EDGE_PRESETS.length)]
    parts.push({
      id: `ap${i}`,
      code: `A${i + 1}`,
      name: `核账件 ${i + 1}`,
      lenMm: 150 + Math.floor(rng() * 950),
      widMm: 120 + Math.floor(rng() * 580),
      qty,
      grain,
      edgeBands,
      cabinet: CABINETS[Math.floor(rng() * CABINETS.length)],
      exposed: rng() < 0.3,
      boardId: ''
    })
    total += qty
  }
  // 把总数修正到恰好 size 件（确定性调整）
  let guard = 0
  while (total !== size && guard++ < 1000000) {
    const idx = Math.floor(rng() * kinds)
    if (total > size && parts[idx].qty > 1) {
      parts[idx].qty--
      total--
    } else if (total < size) {
      parts[idx].qty++
      total++
    }
  }
  return {
    id: `audit-${size}`,
    name: `核账档位 ${size} 件`,
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
    parts,
    kerfMm: 3.2,
    trimMm: 8,
    useOffcutIds: [],
    batchByCabinet: false
  }
}

// ---------------------------------------------------------------------------
// 结果签名（同一单算两遍，逐项对）

interface SheetSig {
  placed: number
  steps: number
  usedAreaMm2: number
  leavesKey: string
}

function leavesKeyOf(leaves: { x: number; y: number; w: number; h: number }[]): string {
  return leaves
    .map((l) => `${Math.round(l.x)},${Math.round(l.y)},${Math.round(l.w)},${Math.round(l.h)}`)
    .sort()
    .join('|')
}

function resultSignature(
  res: NestResult,
  kerf: number,
  simLeaves?: { x: number; y: number; w: number; h: number }[][]
): { boards: number; placed: number; sheets: SheetSig[] } {
  return {
    boards: res.boardsUsed,
    placed: res.sheets.reduce((a, s) => a + s.placements.length, 0),
    sheets: res.sheets.map((s, i) => {
      const leaves =
        simLeaves?.[i] ?? simulate(s.wMm, s.hMm, kerf, s.steps, s.placements).leaves
      return {
        placed: s.placements.length,
        steps: s.steps.length,
        usedAreaMm2: s.usedAreaMm2,
        leavesKey: leavesKeyOf(leaves)
      }
    })
  }
}

function diffSignatures(
  a: { boards: number; placed: number; sheets: SheetSig[] },
  b: { boards: number; placed: number; sheets: SheetSig[] }
): string[] {
  const bad: string[] = []
  if (a.placed !== b.placed) bad.push(`件数（排样内核）：${a.placed} ≠ ${b.placed}`)
  if (a.boards !== b.boards) bad.push(`用板张数（排样内核）：${a.boards} ≠ ${b.boards}`)
  const n = Math.max(a.sheets.length, b.sheets.length)
  for (let i = 0; i < n; i++) {
    const x = a.sheets[i]
    const y = b.sheets[i]
    if (!x || !y) {
      bad.push(`第 ${i + 1} 张板：一遍有一遍没有（排样内核不稳）`)
      continue
    }
    if (x.placed !== y.placed) bad.push(`第 ${i + 1} 张板件数（排样内核）：${x.placed} ≠ ${y.placed}`)
    if (x.steps !== y.steps) bad.push(`第 ${i + 1} 张板刀路步数（刀路生成）：${x.steps} ≠ ${y.steps}`)
    if (x.usedAreaMm2 !== y.usedAreaMm2)
      bad.push(`第 ${i + 1} 张板净面积（排样内核）：${x.usedAreaMm2} ≠ ${y.usedAreaMm2}`)
    if (x.leavesKey !== y.leavesKey) bad.push(`第 ${i + 1} 张板逐刀还原（逐刀模拟）不一致`)
  }
  return bad
}

// ---------------------------------------------------------------------------
// 单档核账

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function runTier(size: number, limit: TierLimit | null | undefined, mem: MemProbe): TierAudit {
  const seed = SEED_BASE + size
  const skips: string[] = []
  const heapAvailable = mem.heapMB() !== null
  if (!heapAvailable) skips.push('内存探针不可用，跳过堆占用测量（本档不卡内存上限）')
  if (!mem.gc) skips.push('未暴露 GC（用 node --expose-gc 启动可测），跳过 GC 后驻留堆测量')

  // 同一单生成两份（同种子），一份计时、一份做稳定性对照
  const jobA = generateTierJob(size, seed)
  const jobB = generateTierJob(size, seed)
  const kinds = jobA.parts.length
  const manifestQty = jobA.parts.reduce((a, p) => a + p.qty, 0)

  mem.gc?.()
  const heap0 = mem.heapMB()
  const t0 = performance.now()
  const resA = nestJob(jobA) // 排样 + 刀路（内核内部已含一次逐刀模拟校验）
  const t1 = performance.now()
  const heap1 = mem.heapMB()
  jobA.result = resA

  const resB = nestJob(jobB) // 同一单第二遍
  const t2 = performance.now()
  jobB.result = resB
  const heap2 = mem.heapMB()

  // 对账：逐刀模拟 + 逐刀守恒（对第一遍的结果，单趟算完）
  let simParts = 0
  let simPartsArea = 0
  let simErr = ''
  let balanceErr = ''
  let stepsTotal = 0
  const simLeaves: { x: number; y: number; w: number; h: number }[][] = []
  for (const s of resA.sheets) {
    const sim = simulate(s.wMm, s.hMm, jobA.kerfMm, s.steps, s.placements)
    simLeaves.push(sim.leaves)
    if (!sim.ok && !simErr) simErr = `第 ${s.index + 1} 张板：${sim.errors[0]}`
    const bal = auditCutBalance(s.wMm, s.hMm, jobA.kerfMm, s.steps, s.placements)
    if (!bal.ok && !balanceErr) balanceErr = `第 ${s.index + 1} 张板：${bal.errors[0]}`
    simParts += bal.finalParts
    simPartsArea += bal.partsAreaMm2
    stepsTotal += s.steps.length
  }
  const t3 = performance.now()
  const heap3 = mem.heapMB()
  mem.gc?.()
  const retained = mem.gc ? mem.heapMB() : null

  // ---- 账面 ----
  const placed = resA.sheets.reduce((a, s) => a + s.placements.length, 0)
  const unplaced = resA.unplaced.reduce((a, u) => a + u.qty, 0)
  const boardArea = resA.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  const usedArea = resA.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const partAreaManifest = jobA.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0)
  const statsUsedArea = resA.sheets.reduce(
    (a, s) => a + s.placements.reduce((x, p) => x + p.origLen * p.origWid, 0),
    0
  )
  let edgeExposed = 0
  let edgeNormal = 0
  for (const s of resA.sheets) {
    for (const p of s.placements) {
      const m =
        (p.origLen * ((p.edgeBands.includes('top') ? 1 : 0) + (p.edgeBands.includes('bottom') ? 1 : 0)) +
          p.origWid * ((p.edgeBands.includes('left') ? 1 : 0) + (p.edgeBands.includes('right') ? 1 : 0))) /
        1000
      if (p.exposed) edgeExposed += m
      else edgeNormal += m
    }
  }
  const account: TierAccount = {
    manifestQty,
    placed,
    unplaced,
    boardsUsed: resA.boardsUsed,
    boardAreaM2: round1(boardArea / 1e6),
    partAreaM2: round1(partAreaManifest / 1e6),
    utilization: boardArea > 0 ? usedArea / boardArea : 0,
    sawOps: countSawOps(resA.sheets),
    stepsTotal,
    edgeBandM: { exposed: round1(edgeExposed), normal: round1(edgeNormal) },
    usableOffcuts: resA.sheets.reduce((a, s) => a + s.offcuts.filter((o) => o.usable).length, 0)
  }

  // ---- 对账（每一档顺带核一遍）----
  const reconcile: CheckResult[] = []
  reconcile.push({
    name: '排下去的件数 = 明细件数',
    ok: placed === manifestQty && unplaced === 0,
    detail:
      placed === manifestQty && unplaced === 0
        ? `排下 ${placed} = 明细 ${manifestQty}`
        : `排下 ${placed}、未排 ${unplaced}，明细 ${manifestQty}`
  })
  reconcile.push({
    name: 'Σ板面积 ≥ Σ零件面积',
    ok: boardArea + 1 >= partAreaManifest,
    detail: `板 ${account.boardAreaM2}m² ≥ 零件 ${account.partAreaM2}m²`
  })
  reconcile.push({
    name: '按刀序逐刀模拟，每块零件都切得出来',
    ok: simErr === '',
    detail: simErr === '' ? `${resA.sheets.length} 张板全部还原` : simErr
  })
  reconcile.push({
    name: '逐刀守恒：每一刀后 件数+余料+锯路 = 整板，还原无盈亏',
    ok: balanceErr === '',
    detail: balanceErr === '' ? `${stepsTotal} 刀刀刀守恒` : balanceErr
  })

  // 同一单算两遍：件数、用板张数、逐刀还原都要一致，对不上就点名哪一步不稳
  const sigA = resultSignature(resA, jobA.kerfMm, simLeaves)
  const sigB = resultSignature(resB, jobB.kerfMm)
  const unstable = diffSignatures(sigA, sigB)
  const determinism = {
    ok: unstable.length === 0,
    detail:
      unstable.length === 0
        ? `两遍一致：件数 ${placed}、用板 ${resA.boardsUsed} 张、逐刀还原相同`
        : `两遍对不上，不稳的一步：${unstable[0]}${unstable.length > 1 ? ` 等 ${unstable.length} 处` : ''}`
  }
  reconcile.push({ name: '同一单算两遍，两次的账一致', ok: determinism.ok, detail: determinism.detail })

  // 自检口径核验（复用 selftest 的断言：净距/guillotine/模拟/利用率复算）
  const selftestProblems = verifyNestJob(jobA)
  reconcile.push({
    name: '自检口径核验（锯路/修边/guillotine/利用率复算）',
    ok: selftestProblems.length === 0,
    detail: selftestProblems.length === 0 ? '通过' : selftestProblems[0]
  })

  // ---- 互相印证：同一份单子，几处部件的结论对账，对不上就点名 ----
  const crossCheck: CheckResult[] = []
  crossCheck.push({
    name: '件数：明细账 = 排样内核 = 逐刀模拟',
    ok: manifestQty === placed && placed === simParts,
    detail:
      manifestQty === placed && placed === simParts
        ? `三处都是 ${placed} 件`
        : `明细 ${manifestQty} / 排样内核 ${placed} / 逐刀模拟切出 ${simParts}`
  })
  crossCheck.push({
    name: '用板张数：排样内核 = 板明细统计',
    ok: resA.boardsUsed === resA.sheets.length,
    detail:
      resA.boardsUsed === resA.sheets.length
        ? `都是 ${resA.boardsUsed} 张`
        : `排样内核 ${resA.boardsUsed} ≠ 板明细统计 ${resA.sheets.length}`
  })
  const areaTol = Math.max(1, placed)
  const kernelVsStats = Math.abs(usedArea - statsUsedArea)
  const kernelVsSim = Math.abs(usedArea - simPartsArea)
  crossCheck.push({
    name: '板面用量：排样内核 = 统计复算 = 逐刀还原',
    ok: kernelVsStats <= areaTol && kernelVsSim <= areaTol,
    detail:
      kernelVsStats <= areaTol && kernelVsSim <= areaTol
        ? `三处都是 ${round1(usedArea / 1e6)}m²`
        : `排样内核 ${round1(usedArea / 1e6)}m² / 统计复算 ${round1(statsUsedArea / 1e6)}m² / 逐刀还原 ${round1(simPartsArea / 1e6)}m²`
  })
  const edgeOk =
    Math.abs(resA.edgeBandM.exposed - edgeExposed) < 0.05 &&
    Math.abs(resA.edgeBandM.normal - edgeNormal) < 0.05
  crossCheck.push({
    name: '封边米数：排样内核 = 统计逐件复算',
    ok: edgeOk,
    detail: edgeOk
      ? `见光 ${round1(edgeExposed)}m / 非见光 ${round1(edgeNormal)}m，两处一致`
      : `排样内核 ${resA.edgeBandM.exposed}/${resA.edgeBandM.normal}m ≠ 统计复算 ${round1(edgeExposed)}/${round1(edgeNormal)}m`
  })

  // ---- 上限卡线 ----
  const heapSamples = [heap1, heap2, heap3].filter((v): v is number => v !== null)
  const heapPeak = heapSamples.length > 0 ? Math.max(...heapSamples) : null
  const heapDelta = heap0 !== null && heapPeak !== null ? heapPeak - heap0 : null
  const nestMs = t1 - t0
  let gate: TierGate | undefined
  if (limit) {
    const timeOverMs = Math.max(0, Math.round(nestMs - limit.maxMs))
    const memOverMB = heapDelta !== null ? Math.max(0, round1(heapDelta - limit.maxHeapMB)) : 0
    gate = {
      maxMs: limit.maxMs,
      maxHeapMB: limit.maxHeapMB,
      timeOk: timeOverMs === 0,
      memOk: heapDelta === null ? true : memOverMB === 0,
      timeOverMs,
      memOverMB
    }
    if (heapDelta === null) skips.push('堆占用量不到，内存上限这一档没卡（记跳过，不记没过）')
  } else if (limit === null) {
    skips.push('上限文件缺失，本档没有卡线（记跳过，不记没过）')
  } else {
    skips.push(`上限文件里没有 ${size} 件这一档的线，本档没卡（记跳过，不记没过）`)
  }

  const measure: TierMeasure = {
    nestMs: Math.round(nestMs),
    secondNestMs: Math.round(t2 - t1),
    reconcileMs: Math.round(t3 - t2),
    heapBeforeMB: heap0 !== null ? round1(heap0) : null,
    heapPeakMB: heapPeak !== null ? round1(heapPeak) : null,
    heapDeltaMB: heapDelta !== null ? round1(heapDelta) : null,
    retainedMB: retained !== null ? round1(retained) : null,
    rssPeakMB: mem.maxRssMB ? (mem.maxRssMB() !== null ? round1(mem.maxRssMB()!) : null) : null
  }

  const reconcileOk = reconcile.every((c) => c.ok)
  const crossOk = crossCheck.every((c) => c.ok)
  const gateOk = gate ? gate.timeOk && gate.memOk : true
  const ok = reconcileOk && crossOk && gateOk

  return {
    size,
    status: ok ? 'pass' : 'fail',
    seed,
    kinds,
    measure,
    account,
    reconcile,
    crossCheck,
    determinism,
    gate,
    skips
  }
}

// ---------------------------------------------------------------------------
// 存档对比：跟上一回比出多了什么、少了什么

function envFingerprint(env: AuditEnv): string {
  return `${env.platform}/${env.arch} ${env.cpuModel}×${env.cpuCount} ${env.totalMemMB}MB node:${env.node ?? '?'}`
}

function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

export function diffReports(prev: AuditReport | null, next: AuditReport): AuditDiff {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  if (!prev) {
    return { hasPrevious: false, added: ['首次核账：本机没有上一回存档，跳过对比'], removed, changed }
  }
  if (prev.env.fingerprint !== next.env.fingerprint) {
    changed.push(
      `运行环境变了（上回 ${prev.env.fingerprint}；这回 ${next.env.fingerprint}），两回的时间与内存数值不能直接摆在一起比`
    )
  }
  if (prev.generator.version !== next.generator.version || prev.generator.seedBase !== next.generator.seedBase) {
    changed.push('单子生成口径变了（生成器版本/种子不同），两回各档数值不能直接比')
  }
  // 上限变化
  const prevTiers = prev.limits?.tiers ?? {}
  const nextTiers = next.limits?.tiers ?? {}
  for (const k of new Set([...Object.keys(prevTiers), ...Object.keys(nextTiers)])) {
    const a = prevTiers[k]
    const b = nextTiers[k]
    if (a && !b) removed.push(`上限：${k} 件档的上限被删了`)
    else if (!a && b) added.push(`上限：新增 ${k} 件档上限 ${b.maxMs}ms / ${b.maxHeapMB}MB`)
    else if (a && b && (a.maxMs !== b.maxMs || a.maxHeapMB !== b.maxHeapMB)) {
      changed.push(`上限：${k} 件档 ${a.maxMs}ms/${a.maxHeapMB}MB → ${b.maxMs}ms/${b.maxHeapMB}MB`)
    }
  }
  // 档位增减与逐档变化
  const prevBySize = new Map(prev.tiers.map((t) => [t.size, t]))
  const nextBySize = new Map(next.tiers.map((t) => [t.size, t]))
  for (const size of nextBySize.keys()) {
    if (!prevBySize.has(size)) added.push(`多了档位 ${size} 件`)
  }
  for (const size of prevBySize.keys()) {
    if (!nextBySize.has(size)) removed.push(`少了档位 ${size} 件（上回有这回没算）`)
  }
  for (const [size, cur] of nextBySize) {
    const old = prevBySize.get(size)
    if (!old) continue
    if (old.status !== cur.status) changed.push(`档位 ${size} 件：上回 ${old.status} → 这回 ${cur.status}`)
    if (old.account && cur.account) {
      if (old.account.boardsUsed !== cur.account.boardsUsed)
        changed.push(`档位 ${size} 件：用板 ${old.account.boardsUsed} → ${cur.account.boardsUsed} 张`)
      if (old.account.placed !== cur.account.placed)
        changed.push(`档位 ${size} 件：排下 ${old.account.placed} → ${cur.account.placed} 件`)
    }
    if (old.measure && cur.measure && old.measure.nestMs > 0 && cur.measure.nestMs > 0) {
      const ratio = cur.measure.nestMs / old.measure.nestMs
      const delta = Math.abs(cur.measure.nestMs - old.measure.nestMs)
      // 小档位绝对耗时太短，比值容易被噪声触发；要有绝对量才报
      if ((ratio > 1.3 || ratio < 0.7) && delta >= 50)
        changed.push(`档位 ${size} 件：排样+刀路 ${old.measure.nestMs}ms → ${cur.measure.nestMs}ms（变化超 30%）`)
    }
    // 对账条目增减
    const oldNames = new Set((old.reconcile ?? []).map((c) => c.name))
    const curNames = new Set((cur.reconcile ?? []).map((c) => c.name))
    for (const n of curNames) if (!oldNames.has(n)) added.push(`档位 ${size} 件多了对账项「${n}」`)
    for (const n of oldNames) if (!curNames.has(n)) removed.push(`档位 ${size} 件少了对账项「${n}」`)
  }
  if (prev.verdict.ok !== next.verdict.ok) {
    changed.push(`总结论：上回 ${prev.verdict.ok ? '全过' : '有没过'} → 这回 ${next.verdict.ok ? '全过' : '有没过'}`)
  }
  return { hasPrevious: true, added, removed, changed }
}

// ---------------------------------------------------------------------------
// 结论（人读）

function fmtMB(v: number | null): string {
  return v === null ? '量不到' : `${v}MB`
}

function buildConclusion(report: AuditReport): string[] {
  const L: string[] = []
  L.push(`开料核账结论 · ${report.startedAt} · 本机 ${report.env.platform}/${report.env.arch} · Node ${report.env.node ?? '?'} · 环境指纹 ${shortHash(report.env.fingerprint)}`)
  L.push(
    `测量口径：时间 = 排样+刀路一遍（nestJob 全程）；内存 = 档位期间堆增量（GC 后基线起量）；上限口径 = ${report.limits?.basis === 'workshop' ? '按车间机器定' : (report.limits?.basis ?? '缺失')}。`
  )
  L.push('—— 档位 ——')
  for (const t of report.tiers) {
    if (t.status === 'rejected') {
      L.push(`  ${t.size} 件：回绝 —— ${t.reason}`)
      continue
    }
    if (t.status === 'skipped') {
      L.push(`  ${t.size} 件：跳过 —— ${t.reason}`)
      continue
    }
    const m = t.measure!
    const a = t.account!
    const g = t.gate
    const over: string[] = []
    if (g) {
      if (!g.timeOk) over.push(`时间超 ${g.timeOverMs}ms（实测 ${m.nestMs}ms / 上限 ${g.maxMs}ms）`)
      if (!g.memOk) over.push(`内存超 ${g.memOverMB}MB（实测 ${fmtMB(m.heapDeltaMB)} / 上限 ${g.maxHeapMB}MB）`)
    }
    const head =
      t.status === 'pass'
        ? `  ${t.size} 件：过`
        : `  ${t.size} 件：没过 —— ${over.join('；') || '对账/印证没对平（见下）'}`
    L.push(
      `${head} —— 排样+刀路 ${m.nestMs}ms${g ? `（上限 ${g.maxMs}ms）` : ''}、` +
        `堆增量 ${fmtMB(m.heapDeltaMB)}${g ? `（上限 ${g.maxHeapMB}MB）` : ''}、` +
        `用板 ${a.boardsUsed} 张、板面利用率 ${(a.utilization * 100).toFixed(1)}%`
    )
    for (const s of t.skips ?? []) L.push(`    跳过：${s}`)
  }
  L.push('—— 对账（每一档顺带核）——')
  for (const t of report.tiers) {
    if (!t.reconcile) continue
    const bad = t.reconcile.filter((c) => !c.ok)
    if (bad.length === 0) {
      L.push(`  ${t.size} 件：件数/面积/逐刀还原/两遍一致 全对平`)
    } else {
      for (const b of bad) L.push(`  ${t.size} 件：「${b.name}」对不上 —— ${b.detail}`)
    }
  }
  L.push('—— 互相印证（排样内核 / 刀路与逐刀模拟 / 自检与统计 / 本机存档）——')
  for (const t of report.tiers) {
    if (!t.crossCheck) continue
    const bad = t.crossCheck.filter((c) => !c.ok)
    if (bad.length === 0) {
      L.push(`  ${t.size} 件：几处结论一致`)
    } else {
      for (const b of bad) L.push(`  ${t.size} 件：对不上 —— 「${b.name}」${b.detail}`)
    }
  }
  if (report.selftestSuite) {
    L.push(
      `—— 自检套件（100 组随机断言）：${report.selftestSuite.ok ? `通过（${report.selftestSuite.detail}）` : `没过 —— ${report.selftestSuite.detail}`}`
    )
  }
  L.push('—— 与上一回存档对比 ——')
  if (!report.diff.hasPrevious) {
    L.push('  首次核账：本机没有上一回存档，跳过对比')
  } else if (report.diff.added.length + report.diff.removed.length + report.diff.changed.length === 0) {
    L.push('  跟上一回比：没有多了什么，也没有少了什么')
  } else {
    for (const s of report.diff.added) L.push(`  多：${s}`)
    for (const s of report.diff.removed) L.push(`  少：${s}`)
    for (const s of report.diff.changed) L.push(`  变：${s}`)
  }
  L.push('—— 既定取舍（两条路都能走，已挑一条并认下后果）——')
  for (const s of report.policy.text) L.push(`  ${s}`)
  const failed = report.verdict.failed
  const passCount = report.tiers.filter((t) => t.status === 'pass').length
  const skipTiers = report.tiers.filter((t) => (t.skips ?? []).length > 0).length
  if (failed.length > 0) {
    L.push(`总结论：${failed.join('、')} 没过，上线前先把这关过了。`)
  } else if (passCount === 0 && report.verdict.rejected.length > 0) {
    L.push(`总结论：没有实测档位（${report.verdict.rejected.join('、')} 被回绝）；回绝本身就是这档的结论。`)
  } else if (!report.limits) {
    L.push(`总结论：${passCount} 档测量全过；但上限文件缺失、卡线没做，这关只算过了一半。`)
  } else if (skipTiers > 0) {
    L.push(`总结论：${passCount} 档全过；有 ${skipTiers} 档存在跳过项（见上，不记没过），这一关可以过。`)
  } else {
    L.push(`总结论：${passCount} 档全过，这一关可以过。`)
  }
  return L
}

// ---------------------------------------------------------------------------
// 主入口

export function runAudit(opts: AuditOptions): AuditReport {
  const t0 = performance.now()
  const sizes = opts.sizes && opts.sizes.length > 0 ? opts.sizes : [...AUDIT_TIERS]
  const tiers: TierAudit[] = []
  for (const size of sizes) {
    if (size > MAX_TIER_SIZE) {
      // 既定取舍一：当场回绝，不砍小（见 POLICY_TEXT）
      tiers.push({
        size,
        status: 'rejected',
        reason: `超过 ${MAX_TIER_SIZE} 件上限，按既定取舍当场回绝、不砍小了接着算；这档量不到数，要接请拆成 ≤${MAX_TIER_SIZE} 件的子单`
      })
      continue
    }
    // limit：undefined = 上限文件里没这档；null = 上限文件整体缺失
    const limit = opts.limits ? opts.limits.tiers[String(size)] : null
    tiers.push(runTier(size, limit, opts.mem))
  }

  // 自检套件（100 组随机断言）在本机跑一遍：自检与统计部件的总开关
  let selftestSuite: CheckResult | null = null
  try {
    const st = runSelfTest()
    selftestSuite = {
      name: '自检套件（100 组随机断言）',
      ok: st.ok,
      detail: st.ok ? `${st.checks.length} 项全过，${st.elapsedMs}ms` : st.checks.find((c) => !c.ok)?.detail ?? '存在失败项'
    }
  } catch (e) {
    selftestSuite = { name: '自检套件（100 组随机断言）', ok: false, detail: `运行异常：${String(e)}` }
  }

  const env = { ...opts.env, fingerprint: envFingerprint(opts.env) }
  const failed: string[] = []
  const skipped: string[] = []
  const rejected: string[] = []
  for (const t of tiers) {
    if (t.status === 'fail') failed.push(`${t.size} 件档`)
    if (t.status === 'skipped') skipped.push(`${t.size} 件档`)
    if (t.status === 'rejected') rejected.push(`${t.size} 件档`)
  }
  if (selftestSuite && !selftestSuite.ok) failed.push('自检套件')

  const report: AuditReport = {
    tool: 'fco-audit',
    version: 1,
    startedAt: opts.nowIso ?? new Date().toISOString(),
    elapsedMs: 0,
    env,
    generator: { version: GEN_VERSION, seedBase: SEED_BASE },
    policy: { oversize: 'reject', limitsBasis: 'workshop', text: POLICY_TEXT },
    limits: opts.limits,
    tiers,
    selftestSuite,
    verdict: { ok: failed.length === 0, failed, skipped, rejected },
    diff: { hasPrevious: false, added: [], removed: [], changed: [] },
    conclusion: []
  }
  report.elapsedMs = Math.round(performance.now() - t0)
  report.diff = diffReports(opts.previous ?? null, report)
  report.conclusion = buildConclusion(report)
  return report
}
