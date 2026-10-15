#!/usr/bin/env node
/**
 * 墨笔 v2 · 「细化下一组」端到端验证（零成本，不调真实模型）
 *
 * 复刻主人截图里的失败现场：
 *   「规划任务：needs_input · chunk-saved · 滚动规划的伏笔引用非法」
 *
 * 做法：走 **真实的 createReplanService**（create → process），只把模型与 repo 换掉。
 * 假模型故意输出真实模型最常见的三种写法漂移：
 *   ① cast 写角色的「名字」而不是 id
 *   ② 伏笔 id 写成 `F1` / `f-2`（大小写 / 连字符漂移）
 *   ③ 伏笔 action 写成中文「埋下」
 * 修复前：这些漂移会让每批 5 章全部作废，任务永远停在 needs_input。
 * 修复后：应看到 status=committed、warning 保留、大纲真的被细化。
 *
 * 用法：node scripts/verify-replan-window.mjs
 * 退出码：0 = 通过；1 = 失败
 */

import assert from 'node:assert/strict'
import { createReplanService } from '../server/replan.js'
import { makeEntity, emptyLedger } from '../server/schema.js'

// ---------- 内存 repo ----------
function makeRepo(project) {
  const projects = new Map([[project.id, project]])
  const runs = new Map()
  return {
    getProject: (id) => projects.get(id),
    saveProject: (p) => { projects.set(p.id, p); return p },
    getRun: (id) => runs.get(id),
    saveRun: (r) => { runs.set(r.id, r); return r },
    listRuns: (pid) => [...runs.values()].filter((r) => !pid || r.projectId === pid),
    // 版本门禁走与生产一致的检查（不实现 commitProjectEdit 时走 saveProject 分支）
  }
}

// ---------- 夹具：一个「只细化了 5 章、后面 131 章是占位」的 136 章作品 ----------
const hero = makeEntity({ name: '林奇', authorRole: '主角' })
const mate = makeEntity({ name: '星野遥', authorRole: '配角' })

function makeProject() {
  const chapters = [{ no: 1, status: 'committed', text: '林奇推开门，喊了一声星野遥。' }]
  const outlineChapters = []
  for (let no = 1; no <= 136; no++) {
    outlineChapters.push(no <= 5
      ? { no, title: `第${no}章`, summary: `已细化摘要${no}`, cast: [hero.id], foreshadows: [] }
      : { no, title: `第${no}章`, pendingDetail: true, foreshadows: [] })
  }
  return {
    id: 'p_e2e', headVersion: 1, editRevision: 1, targetChapters: 136,
    pendingReplan: false,
    entities: [hero, mate],
    chapters,
    ledger: emptyLedger(),
    outline: {
      plannedDetailThrough: 5,
      planningMode: 'rolling',
      totalChapters: 136,
      theme: '社死系统',
      foreshadows: [
        { id: 'f1', seed: '系统提示音异常', payoff: '系统真身', plantChapter: 7, payoffChapter: 130 },
        { id: 'f2', seed: '旧手机里的一段录像', payoff: '身世', plantChapter: 9, payoffChapter: 120 },
      ],
      volumes: [{ title: '第一卷 社死开局', goal: '开局', chapters: outlineChapters }],
    },
  }
}

// ---------- 假模型：返回恰好 count 章，且故意带写法漂移 ----------
let calls = 0
const seenPrompts = []
async function fakeModel({ messages, jsonMode, maxTokens }) {
  calls++
  const user = String(messages.find((m) => m.role === 'user')?.content || '')
  seenPrompts.push(user)
  // 从提示词里读窗口范围（新版文案：请为第X到第Y章规划恰好N章）
  // 从提示词里读窗口范围（文案：请为第X到Y章规划恰好N章——注意「到」后面没有第二个「第」）
  const m = /请为第(\d+)到(\d+)章规划恰好(\d+)章/.exec(user)
  assert.ok(m, '提示词里应包含窗口范围说明（脚本 mock 需要跟着文案走）')
  const from = Number(m[1]), count = Number(m[3])
  const chapters = []
  for (let i = 0; i < count; i++) {
    const no = from + i
    const drift = i % 3
    chapters.push({
      title: `规划章${no}`,
      summary: `第${no}章的作者侧摘要`,
      goal: `第${no}章目标`,
      writerSummary: `表层摘要${no}`,
      writerGoal: `表层目标${no}`,
      // ① 漂移：写名字而不是 id（交替：名字 / id / 带空格的名字）
      cast: drift === 0 ? ['林奇'] : drift === 1 ? [hero.id] : ['星 野遥'],
      // ②③ 漂移：F1 大写、f-2 连字符、中文动作「埋下」
      foreshadows: no === from ? [{ id: 'F1', action: '埋下' }]
        : no === from + 1 ? [{ id: 'f-2', action: 'reinforce' }]
          : [],
    })
  }
  return { text: JSON.stringify({ chapters }), usage: { inputTokens: 1200, outputTokens: 900 }, finishReason: 'stop' }
}

// ---------- 跑 ----------
const project = makeProject()
const repo = makeRepo(project)
const svc = createReplanService({
  repo,
  model: fakeModel,
  config: () => ({ pricing: { inRate: 1, outRate: 2 }, replanBudget: 1e9 }),
})

console.log('==============================================')
console.log(' 墨笔 v2 · 细化窗口端到端验证（假模型，零成本）')
console.log('==============================================')
console.log(`  作品        : ${project.id} | 目标 ${project.targetChapters} 章`)
console.log(`  已细化到    : 第 ${project.outline.plannedDetailThrough} 章`)
console.log('')

let failed = false
try {
  const run = svc.create(project.id, { mode: 'window' })
  console.log(`  任务        : ${run.id}`)
  console.log(`  窗口        : 第 ${run.windowStart} 章起，共 ${run.windowCount} 章`)
  console.log('')

  const done = await svc.process(run.id)
  console.log(`  最终状态    : ${done.status} | step=${done.step}`)
  if (done.error) console.log(`  ❌ 错误     : ${done.error}`)
  if (done.warnings?.length) {
    console.log(`  ⚠️  警告 ${done.warnings.length} 条（这些正是修复前会让整批作废的漂移）：`)
    for (const w of done.warnings) console.log(`      · ${w}`)
  }
  console.log(`  模型调用    : ${calls} 次`)
  console.log('')

  // ---------- 断言 ----------
  assert.equal(done.status, 'committed', `任务应提交成功，实际 ${done.status}（${done.error || '无错误信息'}）`)
  // 成功路径必须显式清空 error（而不是留着上一次失败的文案）：
  // 界面同时显示「已完成」和旧报错，会让人以为修复没生效。
  assert.ok(!done.error, `成功路径不应残留 error，实际 ${JSON.stringify(done.error)}`)

  const p2 = repo.getProject(project.id)
  const chs = p2.outline.volumes.flatMap((v) => v.chapters)
  assert.equal(p2.outline.plannedDetailThrough, 10, '已细化位置应推进到第 10 章')
  assert.equal(p2.outline.planningMode, 'rolling', '还有占位章节时模式仍是 rolling')

  const c6 = chs.find((c) => c.no === 6)
  assert.deepEqual(c6.cast, [hero.id], 'cast 里的名字「林奇」应被归一到 id')
  assert.deepEqual(c6.foreshadows, [{ id: 'f1', action: 'plant', approved: true }],
    'F1 + 中文「埋下」应归一为 f1/plant')
  const c7 = chs.find((c) => c.no === 7)
  assert.deepEqual(c7.foreshadows, [{ id: 'f2', action: 'reinforce', approved: true }],
    'f-2 应归一为 f2')
  const c8 = chs.find((c) => c.no === 8)
  assert.equal(c8.pendingDetail, undefined, '第 8 章应已被细化（不再是占位）')
  assert.deepEqual(c8.cast, [mate.id], '带空格的「星 野遥」应归一到 id')

  // 连续性：1..136 无洞
  assert.equal(chs.length, 136, '章节总数不应变化')
  for (let i = 0; i < chs.length; i++) assert.equal(chs[i].no, i + 1, `第 ${i + 1} 位章号应为 ${i + 1}`)

  // 已写正文字一字未改
  assert.equal(p2.chapters[0].text, '林奇推开门，喊了一声星野遥。', '正式正文不得被改动')

  // 提示词里必须真的摆出了可用 id 清单（否则模型只能瞎猜）
  const first = seenPrompts[0]
  assert.ok(first.includes('可用的角色 ID'), '提示词应列出可用角色 ID')
  assert.ok(first.includes(hero.id), '提示词应包含主角 id')
  assert.ok(first.includes('本作现有的伏笔 ID'), '提示词应列出伏笔 ID 清单')

  console.log('  ✅ 细化窗口已可用（漂移全部归一，任务提交成功）')
} catch (e) {
  failed = true
  console.log(`  ❌ 失败：${e.message}`)
  if (process.env.DEBUG) console.log(e.stack)
}
console.log('')
console.log(failed ? '❌ 仍失败' : '✅ 通过')
process.exit(failed ? 1 : 0)
