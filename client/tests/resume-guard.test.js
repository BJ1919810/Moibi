/**
 * `needs_input` + 正文已写 + 记忆已抽取（失败在提交门禁）时的恢复语义。
 *
 * ⚠️ 语义在 v2.0.0 修复后**反转**过一次，记录在这里避免以后改回去：
 *
 *   旧语义：这种情况**直接拒绝恢复**，理由是「重试只会撞同一条 throw，是死循环」，
 *           并指引用户走「重新生成本章正文」。
 *   旧语义的致命缺陷：它假设**门禁规则不会变**。真实事故
 *           run_c8e0be16fa8cb747837a7698 —— 第 2 章 2353 字正文已生成、钱已花掉，
 *           因为旧门禁把「提取残缺」当 error 而整章作废；修好门禁之后，
 *           这条护栏仍然把它挡在门外，而**界面上根本没有「重新生成本章」入口**。
 *           结果：正文永远取不出来，作品还被并行保护永久锁死。
 *
 *   新语义：**先真的试一次提交**。提交是纯函数 + CAS，幂等、**不调模型、不花钱**。
 *           成功就落盘；确实仍失败才把那次失败如实报出来。
 *           要守护的不变式只剩一条：**恢复绝不重复调用模型**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, emptyLedger, makeFact, makeState } from '../server/schema.js'
import { createWorkflow } from '../server/workflow.js'

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
function repoOf(projects, runs) {
  return { getProject: (id) => clone(projects.get(id)), saveProject: (p) => projects.set(p.id, clone(p)),
    getRun: (id) => clone(runs.get(id) || null), saveRun: (r) => runs.set(r.id, clone(r)),
    listRuns: () => [...runs.values()].map(clone) }
}

test('恢复护栏：门禁失败的 needs_input，恢复只重试提交、绝不重复调用模型', async () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  let writes = 0, extracts = 0
  const model = async (args) => {
    if (args.jsonMode) {
      extracts++
      // ⚠️ 这里必须造成一个**error 级**（真损坏）的提交失败 —— 见 state-engine 的 VIOLATION 表。
      //    证据对不上现在只是 warning（跳过该条），不再能让提交失败；
      //    error 级只剩 UNSUPPORTED_KIND / TIME_REGRESSION。
      //    所以给一句**正文里逐字可查**的证据，让问题落到「时间回退」这条硬拦上：
      //    作品里已有第 9 章的位置状态，本章（第 2 章）又声称要改同一属性 ⇒ 时间线倒退。
      return { text: JSON.stringify({ summary: '调查', facts: [], states: [{ subject: '林舟', attribute: '位置', value: '档案馆', evidence: '林舟把旧纸展开' }], knowledge: [], threads: [], resolved: [] }), usage: { inputTokens: 50, outputTokens: 30 } }
    }
    writes++
    return { text: '林舟把旧纸展开，从中看到了新的线索。', usage: { inputTokens: 100, outputTokens: 60 }, finishReason: 'stop' }
  }
  const wf = createWorkflow({ repo: repoOf(projects, runs), model, config: () => ({ model: 'mock' }) })
  const run = wf.createRun('p_integration', 2, { requestKey: 'stuck-at-commit' })
  // 制造「既有状态在第 9 章」的前提（否则本章改位置不会构成倒退）
  const before = projects.get('p_integration')
  before.ledger.currentState.push(makeState({ subjectId: before.entities[0].id, attribute: '位置', value: '旧邮局', sinceChapter: 9 }))
  projects.set('p_integration', before)
  // 提交门禁拒绝会把异常抛给调用方（既有行为），但 run 已经被落盘为 needs_input。
  await assert.rejects(() => wf.process(run.id), /非法状态转移|时间倒退/)

  const stuck = wf.getRun(run.id)
  assert.equal(stuck.status, 'needs_input')
  assert.ok(stuck.draft.text, '草稿正文应保留（已付费的成果不能丢）')
  assert.equal(stuck.draft.extractOk, true, '记忆抽取已完成，问题出在提交门禁')

  // 新语义：恢复会真的重试一次提交（不调模型、不花钱）。门禁仍然不过 ⇒ 如实报错。
  await assert.rejects(() => wf.resume(run.id), /提交门禁仍未通过/)
  assert.equal(writes, 1, '恢复绝不能重写正文')
  assert.equal(extracts, 1, '恢复绝不能重新抽取记忆')
  assert.equal(wf.getRun(run.id).status, 'needs_input')
  assert.equal(projects.get('p_integration').headVersion, 1, '正式作品不能被推进')
})

test('门禁放宽后，原本卡死的任务能靠「恢复」取回已付费的正文', async () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  let writes = 0, extracts = 0
  const model = async (args) => {
    if (args.jsonMode) {
      extracts++
      // 提取残缺：给了主体、给了**正文里逐字可查的**证据，却没给属性/取值。
      // 修复前 missing-field 是 error ⇒ 整章作废、作品锁死；
      // 修复后是 warning ⇒ 只跳过这一条，正文照常提交。
      return { text: JSON.stringify({ summary: '调查', facts: [], states: [{ subject: '林舟', evidence: '林舟把旧纸展开' }], knowledge: [], threads: [], resolved: [] }), usage: { inputTokens: 50, outputTokens: 30 } }
    }
    writes++
    return { text: '林舟把旧纸展开，从中看到了新的线索。', usage: { inputTokens: 100, outputTokens: 60 }, finishReason: 'stop' }
  }
  const wf = createWorkflow({ repo: repoOf(projects, runs), model, config: () => ({ model: 'mock' }) })
  const run = wf.createRun('p_integration', 2, { requestKey: 'salvage' })
  await wf.process(run.id)

  assert.equal(wf.getRun(run.id).status, 'committed', '提取残缺不该再卡住整章')
  assert.equal(writes, 1)
  assert.equal(extracts, 1)
  assert.equal(projects.get('p_integration').headVersion, 2)
})

test('门禁放宽后，停在 needs_input 的旧任务靠「恢复」能取回已付费的正文', async () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  let writes = 0, extracts = 0
  const model = async (args) => {
    if (args.jsonMode) {
      extracts++
      return { text: JSON.stringify({ summary: '调查', facts: [], states: [{ subject: '林舟', evidence: '林舟把旧纸展开' }], knowledge: [], threads: [], resolved: [] }), usage: { inputTokens: 50, outputTokens: 30 } }
    }
    writes++
    return { text: '林舟把旧纸展开，从中看到了新的线索。', usage: { inputTokens: 100, outputTokens: 60 }, finishReason: 'stop' }
  }
  const wf = createWorkflow({ repo: repoOf(projects, runs), model, config: () => ({ model: 'mock' }) })
  const run = wf.createRun('p_integration', 2, { requestKey: 'resume-salvage' })
  // 模拟「旧代码时代」留下的现场：正文与抽取都已完成，状态停在 needs_input。
  runs.set(run.id, { ...runs.get(run.id), status: 'needs_input', step: 'extracted',
    draft: { no: 2, title: '查找', text: '林舟把旧纸展开，从中看到了新的线索。', extractOk: true,
      extracted: { summary: '调查', facts: [], states: [{ subject: '林舟', evidence: '林舟把旧纸展开' }], knowledge: [], threads: [], resolved: [] },
      report: { violations: [] } },
    error: '状态变化缺少属性或取值（subject=林舟）' })

  const done = await wf.resume(run.id)
  assert.equal(done.status, 'committed', '恢复应直接取回正文，而不是把它永远锁在 run 里')
  // 关键证据：恢复过程**一次模型都没调**（writes/extracts 均为 0）——
  // 它是拿 run 里已存好的正文与抽取结果直接提交，因此不花一分钱。
  assert.equal(writes, 0, '恢复绝不能重写正文')
  assert.equal(extracts, 0, '恢复绝不能重新抽取记忆')
  assert.equal(projects.get('p_integration').headVersion, 2)
})

test('恢复护栏边界：正文已写但抽取尚未完成的 needs_input 仍可正常恢复', async () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  let writes = 0, extracts = 0, fail = true
  const model = async (args) => {
    if (args.jsonMode) {
      extracts++
      if (fail) throw new Error('临时失败')
      return { text: JSON.stringify({ summary: '完成调查', facts: [], states: [], knowledge: [], threads: [], resolved: [] }), usage: { inputTokens: 50, outputTokens: 30 } }
    }
    writes++
    return { text: '林舟把旧纸展开，从中看到了新的线索。', usage: { inputTokens: 100, outputTokens: 60 }, finishReason: 'stop' }
  }
  const wf = createWorkflow({ repo: repoOf(projects, runs), model, config: () => ({ model: 'mock' }) })
  const run = wf.createRun('p_integration', 2, { requestKey: 'guard-edge' })
  await wf.process(run.id)

  assert.equal(wf.getRun(run.id).status, 'needs_input')
  assert.equal(wf.getRun(run.id).draft.extractOk, false)

  fail = false
  await wf.resume(run.id)
  assert.equal(writes, 1, '恢复不得重写正文')
  assert.equal(wf.getRun(run.id).status, 'committed')
  assert.equal(projects.get('p_integration').headVersion, 2)
})

test('停住的 needs_input 不该永久锁死整个作品（可继续写下一章）', () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  const wf = createWorkflow({ repo: repoOf(projects, runs), model: async () => ({ text: '', usage: {} }), config: () => ({ model: 'mock' }) })
  // 手动摆一个停住的 needs_input（模拟真实事故里第 2 章卡死的样子）
  runs.set('run_stuck', { id: 'run_stuck', projectId: 'p_integration', chapterNo: 2, status: 'needs_input', step: 'extracted' })
  // 用户想写第 2 章 —— 不该被那个停住的任务拦住
  const r = wf.createRun('p_integration', 2, { requestKey: 'after-stuck' })
  assert.equal(r.status, 'queued')
})

test('正在生成中的任务仍然锁住作品（并行保护不能被放宽过头）', () => {
  const projects = new Map([['p_integration', story()]])
  const runs = new Map()
  const wf = createWorkflow({ repo: repoOf(projects, runs), model: async () => ({ text: '', usage: {} }), config: () => ({ model: 'mock' }) })
  for (const st of ['queued', 'planning', 'writing', 'extracting', 'awaiting_acceptance']) {
    runs.clear()
    runs.set('run_active', { id: 'run_active', projectId: 'p_integration', chapterNo: 2, status: st, step: st })
    assert.throws(() => wf.createRun('p_integration', 2, { requestKey: `block-${st}` }), /已有未完成的生成任务/, `${st} 状态应锁住作品`)
  }
})
