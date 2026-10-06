<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  useStore,
  createJob,
  deleteJob,
  duplicateJob,
  createSampleJob,
  importJobJson,
  browserAuditStorage,
  loadAuditReports
} from '../lib/store'
import { runSelfTest, type SelfTestReport } from '../lib/selftest'
import { runCapacityAudit, fmtBytes, type AuditReport, type TierReport } from '../lib/audit'
import { toast } from '../lib/ui'
import { pct, money } from '../lib/format'

const router = useRouter()
const { state } = useStore()
const newName = ref('')
const showSelfTest = ref(false)
const report = ref<SelfTestReport | null>(null)
const testing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const showAudit = ref(false)
const auditReport = ref<AuditReport | null>(null)
const auditing = ref(false)

const jobs = computed(() => state.jobs)
const availableOffcuts = computed(() => state.offcuts.filter((o) => o.available).length)

function totalQty(jobId: string): number {
  const j = state.jobs.find((x) => x.id === jobId)
  return j ? j.parts.reduce((a, p) => a + p.qty, 0) : 0
}

function onCreate(): void {
  const job = createJob(newName.value)
  newName.value = ''
  router.push(`/parts/${job.id}`)
}
function onSample(): void {
  const job = createSampleJob()
  router.push(`/parts/${job.id}`)
}
function onDelete(id: string, name: string): void {
  if (window.confirm(`删除项目「${name}」？该操作不可恢复。`)) {
    deleteJob(id)
    toast('项目已删除', 'good')
  }
}
function onDuplicate(id: string): void {
  const j = duplicateJob(id)
  if (j) toast('已复制（排样结果需重新生成）', 'good')
}
async function runTest(): Promise<void> {
  testing.value = true
  report.value = null
  await new Promise((r) => setTimeout(r, 30))
  try {
    report.value = runSelfTest()
    toast(report.value.ok ? '算法自检全部通过' : '存在失败断言，请查看', report.value.ok ? 'good' : 'bad')
  } finally {
    testing.value = false
  }
}
function toggleAudit(): void {
  showAudit.value = !showAudit.value
  // 打开时先亮出本机存档的上回结论；点「运行容量核账」才重算
  if (showAudit.value && !auditReport.value) {
    auditReport.value = loadAuditReports()[0] ?? null
  }
}
async function runAudit(): Promise<void> {
  auditing.value = true
  await new Promise((r) => setTimeout(r, 30))
  try {
    auditReport.value = runCapacityAudit({ storage: browserAuditStorage })
    toast(
      auditReport.value.ok ? '容量核账全档通过，结论已存本机' : '有档位未过，请查看结论',
      auditReport.value.ok ? 'good' : 'bad'
    )
  } finally {
    auditing.value = false
  }
}
function tierTag(t: TierReport): string {
  return t.status === 'pass' ? 'good' : t.status === 'fail' ? 'bad' : ''
}
function tierText(t: TierReport): string {
  return t.status === 'pass' ? '通过' : t.status === 'fail' ? '未过' : '回绝'
}
const auditIssues = computed(() => {
  if (!auditReport.value) return []
  return auditReport.value.tiers.flatMap((t) =>
    t.checks
      .filter((c) => !c.ok || c.skipped)
      .map((c) => ({ ...c, name: `${t.pieces} 件档 · ${c.name}` }))
  )
})
function onImportClick(): void {
  fileInput.value?.click()
}
function onFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const job = importJobJson(String(reader.result))
    if (job) {
      toast('项目 JSON 已导入', 'good')
      router.push(`/parts/${job.id}`)
    } else {
      toast('文件格式不正确', 'bad')
    }
  }
  reader.readAsText(file)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div>
    <section class="hero panel no-print">
      <div>
        <h1>板材开料优化</h1>
        <p class="muted" style="margin: 6px 0 0">
          录入柜体零件 → guillotine 贯通排样（纹理/锯路/修边硬约束）→ 裁切步骤动画 → 下料单/标签。
          纯前端运行，断网可用，数据只存在本机。
        </p>
      </div>
      <div class="spacer" />
      <div class="hero-actions">
        <input
          v-model="newName"
          placeholder="新项目名称，如：万科3-1802"
          @keydown.enter="onCreate"
          style="width: 230px"
        />
        <button class="primary" @click="onCreate">＋ 新建项目</button>
        <button @click="onSample">载入示例 BOM</button>
        <button @click="onImportClick">导入 JSON</button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onFile"
        />
      </div>
    </section>

    <div class="row wrap" style="margin: 16px 0 10px">
      <h2 style="font-size: 16px">项目列表（{{ jobs.length }}）</h2>
      <div class="spacer" />
      <router-link to="/offcuts" class="tag good">可用余料 {{ availableOffcuts }} 块 →</router-link>
      <button class="sm" @click="showSelfTest = !showSelfTest">
        {{ showSelfTest ? '收起' : '运行' }}算法自检（100 组随机断言）
      </button>
      <button class="sm" @click="toggleAudit">
        {{ showAudit ? '收起' : '' }}容量核账（100/300/600/1000 件）
      </button>
    </div>

    <section v-if="showSelfTest" class="panel selftest no-print">
      <div class="row">
        <button class="primary sm" :disabled="testing" @click="runTest">
          {{ testing ? '自检中…' : '运行自检' }}
        </button>
        <span v-if="report" :class="['tag', report.ok ? 'good' : 'bad']">
          {{ report.ok ? `全部通过（${report.elapsedMs}ms）` : '存在失败项' }}
        </span>
        <span class="muted small">
          覆盖：100 组 guillotine 零反例、纹理零旋转、锯路/修边、守恒、封边复算、
          30 件 ≤20 刀且逐刀模拟还原、余料再利用、300 件 &lt;1.5s、微调合法性
        </span>
      </div>
      <table v-if="report" class="grid" style="margin-top: 10px">
        <tbody>
          <tr v-for="(c, i) in report.checks" :key="i">
            <td style="width: 34px; text-align: center">{{ c.ok ? '✅' : '❌' }}</td>
            <td>{{ c.name }}</td>
            <td class="muted small">{{ c.detail }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="showAudit" class="panel selftest no-print">
      <div class="row">
        <button class="primary sm" :disabled="auditing" @click="runAudit">
          {{ auditing ? '核账中…' : '运行容量核账' }}
        </button>
        <span v-if="auditReport" :class="['tag', auditReport.ok ? 'good' : 'bad']">
          {{ auditReport.ok ? `全档通过（${auditReport.elapsedMs}ms）` : '有档位/互证未过' }}
        </span>
        <span class="muted small">
          四档各算一遍排样与刀路，量耗时/内存/用板/板面利用，按事先讲好的上限卡档；
          排样内核、逐刀模拟、自检断言、统计复核、本机存档五处互证；结论存本机并与上一回比。
          上线前把关请在终端跑 <code>npm run verify</code>。
        </span>
      </div>
      <template v-if="auditReport">
        <table class="grid" style="margin-top: 10px">
          <thead>
            <tr>
              <th>档位</th><th>判定</th><th>耗时 / 上限</th><th>内存 / 上限</th>
              <th>用板（张）</th><th>板面利用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in auditReport.tiers" :key="t.pieces">
              <td>{{ t.pieces }} 件</td>
              <td><span :class="['tag', tierTag(t)]">{{ tierText(t) }}</span></td>
              <td>{{ t.timeMs === null ? '无计时' : `${t.timeMs}ms / ${t.limitTimeMs}ms` }}</td>
              <td>
                {{ t.memoryBytes === null ? '无探针' : `${fmtBytes(t.memoryBytes)} / ${fmtBytes(t.limitMemoryBytes ?? 0)}` }}
              </td>
              <td>{{ t.boardsUsed ?? '—' }}</td>
              <td>{{ t.utilization === null ? '—' : pct(t.utilization) }}</td>
            </tr>
          </tbody>
        </table>
        <table v-if="auditIssues.length > 0" class="grid" style="margin-top: 8px">
          <tbody>
            <tr v-for="(c, i) in auditIssues" :key="i">
              <td style="width: 34px; text-align: center">{{ c.skipped ? '⏭️' : '❌' }}</td>
              <td>{{ c.name }}</td>
              <td class="muted small">{{ c.detail }}</td>
            </tr>
          </tbody>
        </table>
        <table class="grid" style="margin-top: 8px">
          <tbody>
            <tr v-for="(c, i) in auditReport.crossChecks" :key="i">
              <td style="width: 34px; text-align: center">{{ c.skipped ? '⏭️' : c.ok ? '✅' : '❌' }}</td>
              <td>{{ c.name }}</td>
              <td class="muted small">{{ c.detail }}</td>
            </tr>
          </tbody>
        </table>
        <p class="small muted" style="margin: 8px 0 0">与上一回比：</p>
        <ul class="small" style="margin: 2px 0 0">
          <li v-for="(d, i) in auditReport.diffFromPrevious" :key="i" class="muted">{{ d }}</li>
        </ul>
        <p class="small muted" style="margin: 8px 0 0">结论：</p>
        <ul class="small" style="margin: 2px 0 0">
          <li v-for="(c, i) in auditReport.conclusions" :key="i">{{ c }}</li>
        </ul>
      </template>
      <p v-else class="muted small" style="margin: 10px 0 0">
        本机还没有核账结论，点「运行容量核账」算一遍；终端入口 <code>npm run audit</code> 与这里同一份核账逻辑。
      </p>
    </section>

    <div v-if="jobs.length === 0" class="empty panel">
      <p>还没有项目。点击右上角「新建项目」或「载入示例 BOM」开始。</p>
    </div>

    <div class="job-grid">
      <article v-for="job in jobs" :key="job.id" class="panel job-card">
        <div class="row">
          <h3 style="font-size: 15px">{{ job.name }}</h3>
          <div class="spacer" />
          <span v-if="job.result" class="tag good">已排样</span>
          <span v-else class="tag">未排样</span>
        </div>
        <p class="muted small" style="margin: 6px 0">
          {{ new Date(job.createdAt).toLocaleString('zh-CN') }} ·
          {{ totalQty(job.id) }} 件零件 · {{ job.boards.length }} 种板材
        </p>
        <div v-if="job.result" class="job-stats">
          <div><b>{{ job.result.boardsUsed }}</b><span>用板（张）</span></div>
          <div>
            <b>{{ pct(job.result.sheets.reduce((a, s) => a + s.usedAreaMm2, 0) /
              job.result.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)) }}</b>
            <span>综合利用率</span>
          </div>
          <div>
            <b class="save">{{ job.result.savedBoards }}</b>
            <span>比随手排省（张）</span>
          </div>
        </div>
        <p v-if="job.result" class="small muted" style="margin: 6px 0 10px">
          约省 {{ money(job.result.savedCents) }} ｜ 封边
          {{ (job.result.edgeBandM.exposed + job.result.edgeBandM.normal).toFixed(1) }}m
        </p>
        <div v-else style="height: 34px"></div>
        <div class="row">
          <router-link :to="`/parts/${job.id}`" class="btn-link">零件清单</router-link>
          <router-link :to="`/nest/${job.id}`" class="btn-link">排样</router-link>
          <router-link :to="`/stats/${job.id}`" class="btn-link">统计</router-link>
          <div class="spacer" />
          <button class="sm" @click="onDuplicate(job.id)">复制</button>
          <button class="sm ghost-danger" @click="onDelete(job.id, job.name)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hero h1 {
  font-size: 20px;
}
.hero-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.selftest {
  margin-bottom: 16px;
}
.empty {
  text-align: center;
  color: var(--c-ink-2);
  padding: 40px;
}
.job-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.job-card {
  display: flex;
  flex-direction: column;
}
.job-stats {
  display: flex;
  gap: 8px;
  margin: 8px 0;
}
.job-stats > div {
  flex: 1;
  background: #f4f7f3;
  border-radius: 6px;
  padding: 8px;
  text-align: center;
}
.job-stats b {
  display: block;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.job-stats .save {
  color: var(--c-primary);
}
.job-stats span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.btn-link {
  font-size: 13px;
  padding: 4px 8px;
}
</style>
