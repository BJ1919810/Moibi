#!/usr/bin/env node
/**
 * 用**真实作品的真实数据**跑一次滚动细化（假模型，零成本）。
 *
 * 与 verify-replan-window.mjs 的区别：那个用合成夹具，这个直接读 data/projects/ 里的
 * 真作品（含真实角色 id、伏笔 id、多卷结构），能暴露夹具里想不到的结构问题。
 *
 * 用法：
 *   node scripts/verify-replan-real-project.mjs                  # 用第一个有多章占位的作品
 *   node scripts/verify-replan-real-project.mjs p_xxxxxxxxxxxx    # 指定作品
 *
 * ⚠️ 全程在内存副本上跑，**不写回 data/projects/**（末尾有断言确认原文件未被改动）。
 */
import * as store from '../server/store.js'
import { createReplanService } from '../server/replan.js'

const PID = process.argv[2] || store.listProjects()
  .map((p) => p.id)
  .find((id) => {
    const p = store.getProject(id)
    return (p?.outline?.volumes || []).flatMap((v) => v.chapters || []).some((c) => c.pendingDetail)
  })

if (!PID) { console.log('没有找到含占位章节的作品'); process.exit(1) }

const proj0 = store.getProject(PID)
const before = JSON.stringify(proj0)
const projects = new Map([[PID, structuredClone(proj0)]])
const runs = new Map()
const repo = {
  getProject: (id) => structuredClone(projects.get(id)),
  saveProject: (p) => { projects.set(p.id, structuredClone(p)); return p },
  getRun: (id) => (runs.has(id) ? structuredClone(runs.get(id)) : null),
  saveRun: (r) => { runs.set(r.id, structuredClone(r)); return r },
  listRuns: (pid) => [...runs.values()].filter((r) => !pid || r.projectId === pid),
}

// 模仿真实模型的坏习惯：名字代替 id、大写 id、`F1`、中文动作
const model = async ({ messages }) => {
  const user = String(messages.find((m) => m.role === 'user').content)
  const m = /请为第(\d+)到(\d+)章规划恰好(\d+)章/.exec(user)
  const from = Number(m[1]), count = Number(m[3])
  const ents = proj0.entities.map((e) => e.name)
  const chapters = []
  for (let i = 0; i < count; i++) {
    const no = from + i
    chapters.push({
      title: `第${no}章 · 樱花树下的余波`,
      summary: `作者侧：第${no}章推进主线，处理上一章留下的情绪与线索。`,
      goal: '推进冲突',
      writerSummary: '表层：主角面对新的局面。',
      writerGoal: '解决眼前问题',
      cast: i === 0 ? [ents[0]]
        : i === 1 ? [`ENT_${proj0.entities[0].id.slice(4).toUpperCase()}`]
          : [proj0.entities[(i + 1) % proj0.entities.length].id],
      foreshadows: i === 0 ? [{ id: 'F1', action: '埋下' }]
        : i === 1 && proj0.outline.foreshadows.length > 1 ? [{ id: 'f-2', action: '强化' }] : [],
    })
  }
  return { text: JSON.stringify({ chapters }), usage: { inputTokens: 3000, outputTokens: 2000 }, finishReason: 'stop' }
}

const svc = createReplanService({ repo, model, config: () => ({ pricing: { inRate: 1, outRate: 2 }, replanBudget: 1e9 }) })

const pending = (proj0.outline.volumes || []).flatMap((v) => v.chapters || []).filter((c) => c.pendingDetail)
console.log('==============================================')
console.log(' 真实作品滚动细化（假模型，零成本）')
console.log('==============================================')
console.log(`  作品      : ${PID}`)
console.log(`  灵感      : ${String(proj0.idea || '').slice(0, 36)}`)
console.log(`  目标      : ${proj0.targetChapters} 章 | 细化到 ${proj0.outline.plannedDetailThrough} | 占位 ${pending.length} 章`)
console.log(`  角色      : ${proj0.entities.map((e) => e.name).join('、')}`)
console.log(`  伏笔      : ${proj0.outline.foreshadows.map((f) => f.id).join('、') || '(无)'}`)
console.log('')

let failed = false
try {
  const run = svc.create(PID, { mode: 'window' })
  console.log(`  窗口      : 第 ${run.windowStart} 章起，共 ${run.windowCount} 章`)
  const done = await svc.process(run.id)
  console.log(`  状态      : ${done.status} | step=${done.step}`)
  if (done.error) console.log(`  ❌ error  : ${done.error}`)
  if (done.warnings?.length) {
    console.log(`  ⚠️  warning ${done.warnings.length} 条：`)
    for (const w of done.warnings.slice(0, 8)) console.log(`      · ${w}`)
  }

  if (done.status !== 'committed') throw new Error(`任务未提交：${done.status} / ${done.error || ''}`)

  const p2 = projects.get(PID)
  const chs = p2.outline.volumes.flatMap((v) => v.chapters)
  console.log('')
  console.log(`  细化到    : ${p2.outline.plannedDetailThrough} | 模式 ${p2.outline.planningMode}`)
  for (let no = run.windowStart; no < run.windowStart + run.windowCount; no++) {
    const c = chs.find((x) => x.no === no)
    const castOk = c.cast.every((id) => p2.entities.some((e) => e.id === id))
    console.log(`   第${no}章 cast=${JSON.stringify(c.cast)} fs=${JSON.stringify(c.foreshadows)} ${castOk ? '' : '⛔ cast 含非法 id'}`)
    if (!castOk) throw new Error(`第 ${no} 章 cast 未归一：${JSON.stringify(c.cast)}`)
  }
  // 已细化窗口内不应再有占位
  const stillPending = chs.filter((c) => c.pendingDetail && c.no >= run.windowStart && c.no < run.windowStart + run.windowCount)
  if (stillPending.length) throw new Error(`窗口内仍有占位：${stillPending.map((c) => c.no).join(',')}`)
  // 章号连续
  const nos = chs.map((c) => c.no)
  if (!nos.every((n, i) => n === i + 1)) throw new Error('章号出现空洞')
  console.log(`  章号连续  : 1..${chs.length} ✅`)

  console.log('')
  console.log('  ✅ 真实作品上细化窗口可用')
} catch (e) {
  failed = true
  console.log('')
  console.log(`  ❌ 失败：${e.message}`)
}

// 无论如何都要确认原作品文件没被改动
const after = JSON.stringify(store.getProject(PID))
if (after !== before) {
  console.log('  ⛔⛔ 原作品文件被改动了！这个脚本不该写盘')
  failed = true
} else {
  console.log('  ✅ data/projects/ 原文件未被改动')
}
console.log('')
console.log(failed ? '❌ 仍失败' : '✅ 通过')
process.exit(failed ? 1 : 0)
