/**
 * 测试左移：先固定提交、恢复、上下文、成本的不可违反条件，再补实现。
 * 所有模型返回都由内存替身提供；不消费实际 API token。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, emptyLedger, makeFact } from '../server/schema.js'
import { compileChapterContext } from '../server/context-compiler.js'
import { prepareChapterPlan } from '../server/chapter-planner.js'
import { commitDraft, createWorkflow } from '../server/workflow.js'
import { calculateCost, assertCostBudget } from '../server/cost.js'

const clone = (x) => structuredClone(x)
function story() {
  const hero = makeEntity({ name: '林舟', authorRole: '主角', publicRole: '主角', publicIdentity: '修复师' })
  const keyFact = makeFact({ text: '林舟持有铜钥匙', entityIds: [hero.id], sourceChapter: 1 })
  return { id: 'p_integration', title: '测试小说', genre: '悬疑', idea: '失落的档案', headVersion: 1,
    entities: [hero], chapters: [{ no: 1, status: 'committed', text: '林舟把铜钥匙收进衣袋。', summary: '林舟取得铜钥匙。' }],
    ledger: { ...emptyLedger(), canonicalFacts: [keyFact] },
    outline: { title: '测试小说', logline: '寻找真相', style: '短句', foreshadows: [],
      volumes: [{ title: '第一卷', chapters: [{ no: 1, cast: [hero.id] },
      { no: 2, title: '查找', cast: [hero.id], writerTaskApproval: 'author-approved', writerSummary: '林舟检查旧档案', writerGoal: '发现遗失页', requiredFactIds: [keyFact.id], foreshadows: [] }] }], totalChapters: 2 } }
}

test('R5: 显式必需的旧事实被保留，Manifest 可追溯且只记录正文授权数据', () => {
  const p = story()
  const result = compileChapterContext(p, 2, { inputBudget: 4000 })
  assert.ok(result.packet.context.facts.includes('林舟持有铜钥匙'))
  assert.ok(result.manifest.entries.some((x) => x.id === p.ledger.canonicalFacts[0].id && x.reason === 'required'))
  assert.ok(result.manifest.packetHash)
  assert.equal(result.manifest.headVersion, 1)
})

test('R5: 必需项超预算必须阻断，不能悄悄截断', () => {
  const p = story()
  p.ledger.canonicalFacts[0].text = '红'.repeat(6000)
  assert.throws(() => compileChapterContext(p, 2, { inputBudget: 450 }), /预算|budget/i)
})

test('L2: 轻量计划只引用可信的历史，不能透传作者侧章节摘要', () => {
  const p = story()
  p.outline.volumes[0].chapters[1].summary = '顾行舟就是幕后黑手，这个真相尚未公开'
  const plan = prepareChapterPlan(p, 2)
  assert.deepEqual(plan.requiredFactIds, [p.ledger.canonicalFacts[0].id])
  assert.ok(!JSON.stringify(plan.writerTask).includes('幕后黑手'))
})

test('R4: 缺少记忆抽取不能提交；正式正文和 head 完全不变', () => {
  const p = story(), before = JSON.stringify(p)
  assert.throws(() => commitDraft(p, { no: 2, text: '林舟读完纸张。', extractOk: false }, 1), /抽取|未完成/)
  assert.equal(JSON.stringify(p), before)
})

// 「主体解析不到实体」原来会被升级成整章拒稿，导致正文写完却永远提交不进去
// （真实踩过：第 2 章卡在「遥学姐」「部室柜子」上）。
// ⚠️ v2.0.0 全量压测后进一步收紧：**证据无法核实也只跳过该条，不废整章**。
//    连续三章（2584 / 2624 / 2298 字）均为**已付费**正文，却各自因为 7 / 6 / 1 条证据的
//    「引用格式」（外层引号、省略号拼接、隔着插叙、单字对白）被整章拒稿 —— 逐条核对后
//    这些证据的内容**全都在正文里**，没有一条是编造。
//    判据与 state-engine 的 VIOLATION 分级一致：这条坏数据**只影响它自己**，不污染别处
//    ⇒ 不把它交给账本即可，整章其余内容完全正常。安全性由「不入账」保证，不是靠「废整章」。
test('R4: 证据不可核实时只跳过该条、不废整章（正文已付费，不能白扔）', () => {
  const p = story(), before = JSON.stringify(p)
  // ① 证据缺失/对不上 → 该条不入账，但本章照常提交
  const r1 = commitDraft(p, { no: 2, title: '查找', text: '林舟读完纸张。', extractOk: true,
    extracted: { summary: '调查', facts: [], states: [{ subject: '林舟', attribute: '位置', value: '档案室' }], knowledge: [], threads: [], resolved: [] } }, 1)
  assert.equal(r1.chapter.status, 'committed', '不得因为一条证据就废掉整章')
  assert.equal(r1.project.ledger.currentState.length, 0, '拿不到证据的变化绝不允许进账本')
  assert.ok(r1.unresolvedSubjects.some((x) => /证据无法核实/.test(x) && /证据|未给出/.test(x)),
    '没入账必须让作者看得见')
  assert.equal(JSON.stringify(p), before, '纯函数不得原地修改传入的正式对象')
  // ② 证据逐字可查、但主体是「不存在的人」→ 同样只跳过该条，本章提交成功
  const ok = commitDraft(p, { no: 2, title: '查找', text: '林舟读完纸张。', extractOk: true,
    extracted: { summary: '调查', facts: [], states: [{ subject: '不存在的人', attribute: '位置', value: '档案室', evidence: '林舟读完纸张。' }], knowledge: [], threads: [], resolved: [] } }, 1)
  assert.equal(ok.project.chapters.length, 2, '主体解析不到不再是拒稿理由')
  assert.equal(ok.project.ledger.currentState.length, 0, '解析不到的这条不入账')
  assert.ok(ok.unresolvedSubjects.some((x) => x.includes('不存在的人')), '跳过了什么必须让作者看得见')
})

test('R4: 基线过期拒绝，重复同一章内容禁止二次推进', () => {
  const p = story()
  const draft = { no: 2, title: '查找', text: '林舟读完纸张。', extractOk: true,
    extracted: { summary: '调查', facts: [], states: [], knowledge: [], threads: [], resolved: [] } }
  const r = commitDraft(p, draft, 1)
  assert.equal(r.project.headVersion, 2)
  assert.equal(p.headVersion, 1, '纯函数不得原地修改传入的正式对象')
  assert.throws(() => commitDraft(r.project, draft, 1), /版本|冲突/)
  assert.throws(() => commitDraft(r.project, draft, 2), /已经|重复|已存在/)
})

test('R4: 失败保留草稿、重试抽取不重写正文、同请求不会产生两次生成', async () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  const repo = { getProject: (id) => clone(projects.get(id)), saveProject: (p) => projects.set(p.id, clone(p)),
    getRun: (id) => clone(runs.get(id) || null), saveRun: (r) => runs.set(r.id, clone(r)),
    listRuns: () => [...runs.values()].map(clone) }
  let writes = 0, extracts = 0
  let failure = true
  const model = async (args) => {
    if (args.jsonMode) {
      extracts++
      if (failure) throw new Error('临时失败')
      return { text: JSON.stringify({ summary: '完成调查', facts: [], states: [], knowledge: [], threads: [], resolved: [] }), usage: { inputTokens: 50, outputTokens: 30 } }
    }
    writes++
    return { text: '林舟把旧纸展开，从中看到了新的线索。', usage: { inputTokens: 100, outputTokens: 60 }, finishReason: 'stop' }
  }
  const wf = createWorkflow({ repo, model, config: () => ({ model: 'mock' }) })
  const initial = wf.createRun('p_integration', 2, { requestKey: 'press-once' })
  assert.equal(wf.createRun('p_integration', 2, { requestKey: 'press-once' }).id, initial.id)
  await wf.process(initial.id)
  assert.equal(wf.getRun(initial.id).status, 'needs_input')
  assert.ok(wf.getRun(initial.id).draft.text)
  assert.equal(projects.get('p_integration').headVersion, 1)
  failure = false
  await wf.resume(initial.id)
  assert.equal(writes, 1)
  assert.equal(extracts, 2)
  assert.equal(wf.getRun(initial.id).status, 'committed')
  assert.equal(projects.get('p_integration').headVersion, 2)
})

test('成本计量：已知价格时按实际 token 计费，超额度在发请求前阻断', () => {
  const c = calculateCost([{ inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 }],
    { inputPerMillion: 1, cachedInputPerMillion: .2, outputPerMillion: 2 })
  assert.ok(Math.abs(c - .00184) < 1e-10)
  assert.throws(() => assertCostBudget(.9, .2, 1), /预算/)
})

test('R4: 计划修订发生在任务冻结后，即使 head 未变也拒绝提交', () => {
  const p = story(); p.editRevision = 2
  const draft = { no: 2, text: '林舟调查旧纸。', extractOk: true,
    extracted: { summary: '调查完成', facts: [], states: [], knowledge: [], threads: [], resolved: [] } }
  assert.throws(() => commitDraft(p, draft, 1, 1), /规划|修订|冲突/)
})

test('R4: 提取的状态缺原文证据 ⇒ 该条不入账并如实记录（正文仍要留住）', () => {
  const p = story()
  const draft = { no: 2, text: '林舟关上旧书。', extractOk: true,
    extracted: { summary: '关上旧书', facts: [], states: [{ subject: '林舟', attribute: '位置', value: '档案馆' }], knowledge: [], threads: [], resolved: [] } }
  const r = commitDraft(p, draft, 1)
  assert.equal(r.chapter.status, 'committed')
  assert.equal(r.project.ledger.currentState.length, 0, '没有证据的变化不得入账')
  assert.ok(r.unresolvedSubjects.some((x) => /未给出证据/.test(x)))
})

test('R4: 明确取消后不允许恢复或接受', async () => {
  const p = story(); const projects = new Map([[p.id, p]]), runs = new Map()
  const repo = { getProject: (id) => clone(projects.get(id)), saveProject: (x) => projects.set(x.id, clone(x)),
    getRun: (id) => clone(runs.get(id) || null), saveRun: (x) => runs.set(x.id, clone(x)),
    listRuns: () => [...runs.values()] }
  const wf = createWorkflow({ repo, model: async () => { throw new Error('不应调用') } })
  const run = wf.createRun(p.id, 2, { requestKey: 'cancel-one' })
  wf.cancel(run.id)
  assert.equal((await wf.process(run.id)).status, 'cancelled')
  await assert.rejects(() => wf.resume(run.id), /不能恢复/)
})

test('L2 未授权任务只能由低权限内容生成，候选秘密触发自检', async () => {
  const { safePlanMessages, applySafePlan } = await import('../server/dynamic-plan.js')
  const p = story()
  p.entities[0].secret = '林舟实际上是失踪案件的策划者'
  const compiled = compileChapterContext(p, 2)
  const messages = safePlanMessages(compiled.packet)
  assert.ok(!JSON.stringify(messages).includes(p.entities[0].secret))
  assert.throws(() => applySafePlan(compiled.packet, p, { summary: p.entities[0].secret, goal: '找到线索' }), /泄漏/)
  const passed = applySafePlan(compiled.packet, p, { summary: '林舟检查旧纸', goal: '找到遗失页' })
  assert.equal(passed.task.goal, '找到遗失页')
})

test('R4: 请求在途时取消，回包不能覆写 cancelled，也不能提交正式章节', async () => {
  const p = story(), projects = new Map([[p.id, p]]), runs = new Map()
  const repo = { getProject: (id) => clone(projects.get(id)), saveProject: (x) => projects.set(x.id, clone(x)),
    getRun: (id) => clone(runs.get(id) || null), saveRun: (x) => runs.set(x.id, clone(x)), listRuns: () => [...runs.values()] }
  let start
  const waiting = new Promise((resolve) => { start = resolve })
  let wrote
  const writing = new Promise((resolve) => { wrote = resolve })
  const wf = createWorkflow({ repo, config: () => ({ inputBudget: 5000 }), model: async () => {
    wrote()
    await waiting
    return { text: '林舟走进档案室。', usage: {inputTokens:50, outputTokens:20} }
  }})
  const r = wf.createRun(p.id, 2, {requestKey:'cancel-during-writing'})
  const processing = wf.process(r.id)
  await writing
  wf.cancel(r.id)
  start()
  await processing
  assert.equal(wf.getRun(r.id).status, 'cancelled')
  assert.equal(projects.get(p.id).headVersion, 1)
})

test('R4: 取消发生在模型异常返回之前，不能被 catch 恢复为可执行任务', async () => {
  const p = story(), projects = new Map([[p.id, p]]), runs = new Map()
  const repo = { getProject: id => clone(projects.get(id)), saveProject: x => projects.set(x.id, clone(x)),
    getRun: id => clone(runs.get(id) || null), saveRun: x => runs.set(x.id, clone(x)),
    listRuns: () => [...runs.values()] }
  let signalStarted, signalReject
  const started = new Promise(resolve => { signalStarted = resolve })
  const failed = new Promise((resolve, reject) => { signalReject = reject })
  const wf = createWorkflow({ repo, config: () => ({ inputBudget: 5000 }), model: async () => {
    signalStarted()
    return failed
  } })
  const run = wf.createRun(p.id, 2, {requestKey:'cancel-before-error'})
  const active = wf.process(run.id)
  await started
  wf.cancel(run.id)
  signalReject(new Error('供应商错误'))
  await active
  assert.equal(wf.getRun(run.id).status, 'cancelled')
  assert.equal(projects.get(p.id).headVersion, 1)
})
