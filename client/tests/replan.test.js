import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, emptyLedger } from '../server/schema.js'
import { applyFuturePlan } from '../server/replan.js'

function p() {
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  return { id: 'p_replan', headVersion: 1, editRevision: 2, targetChapters: 4, pendingReplan: true,
    entities: [hero], chapters: [{ no: 1, status: 'committed', text: '林舟在门外等候。' }], ledger: emptyLedger(),
    outline: { foreshadows: [], totalChapters: 3, volumes: [{ title: '第一卷', chapters: [
      { no: 1, title: '已写', cast: [hero.id] }, { no: 2, title: '旧计划', cast: [hero.id] }, { no: 3, title: '旧计划3', cast: [hero.id] }] }] } }
}

test('重排只覆盖未来规划，已经提交的正文/计划不变化', () => {
  const old = p(), hero = old.entities[0]
  const proposed = Array.from({length: 3}, (_, i) => ({ title: `新${i+2}`, summary: '作者侧规划', goal: '找到线索', cast: [hero.id], foreshadows: [] }))
  const { project: r } = applyFuturePlan(old, proposed, { expectedHeadVersion: 1, expectedEditRevision: 2 })
  assert.equal(r.outline.totalChapters, 4)
  assert.equal(r.outline.volumes[0].chapters[0].title, '已写')
  assert.equal(r.chapters[0].text, '林舟在门外等候。')
  assert.equal(r.pendingReplan, false)
  assert.equal(r.editRevision, 3)
  assert.equal(old.outline.totalChapters, 3)
})

test('重排不允许伪造新实体、少交章节、覆盖过期修订', () => {
  const old = p()
  assert.throws(() => applyFuturePlan(old, [{ title: 'X', cast: ['fake'] }], { expectedHeadVersion: 1, expectedEditRevision: 2 }), /数量/)
  assert.throws(() => applyFuturePlan(old, [], { expectedHeadVersion: 1, expectedEditRevision: 1 }), /版本/)
})

// 外键写法漂移是**真实模型最常见的失败模式**（f1 → F1 / "F 1" / 名字而非 id）。
// 旧实现直接整批 throw，用户看到的就是「细化下一组」永远失败。现在改为：
// 能归一就归一，归一不到只丢该条并留下 warning，绝不因一条噪声毁掉整批。
test('模型把角色 id 写成名字时自动归一，不再整批作废', () => {
  const old = p(), hero = old.entities[0]
  const proposed = Array.from({ length: 3 }, (_, i) => ({ title: `新${i + 2}`, cast: ['林舟'], foreshadows: [] }))
  const { project: r, warnings } = applyFuturePlan(old, proposed, { expectedHeadVersion: 1, expectedEditRevision: 2 })
  assert.deepEqual(r.outline.volumes.at(-1).chapters[0].cast, [hero.id])
  assert.equal(warnings.length, 0, '名字能对上就不算警告')
})

test('模型把伏笔 id 写成 F1 / f-1 时归一到大纲里的 f1', async () => {
  const { applyRollingWindowPlan } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const base = { id: 'p_w', headVersion: 1, editRevision: 1, targetChapters: 3, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 1, foreshadows: [{ id: 'f1', seed: 's', payoff: 'p', plantChapter: 2, payoffChapter: 3 }],
      volumes: [{ title: '卷一', chapters: [
        { no: 1, title: '已细化' }, { no: 2, title: '待细化', pendingDetail: true },
        { no: 3, title: '待细化', pendingDetail: true }] }] } }
  const proposals = [
    { title: 'w2', cast: ['林舟'], foreshadows: [{ id: 'F1', action: 'plant' }] },
    { title: 'w3', cast: [hero.id], foreshadows: [{ id: 'f-1', action: '强化' }] },
  ]
  const { project: r, warnings } = applyRollingWindowPlan(base, proposals,
    { expectedHeadVersion: 1, expectedEditRevision: 1, fromNo: 2 })
  const ch2 = r.outline.volumes[0].chapters.find((c) => c.no === 2)
  const ch3 = r.outline.volumes[0].chapters.find((c) => c.no === 3)
  assert.deepEqual(ch2.foreshadows, [{ id: 'f1', action: 'plant', approved: true }])
  assert.deepEqual(ch3.foreshadows, [{ id: 'f1', action: 'reinforce', approved: true }])
  assert.equal(warnings.length, 0)
  assert.equal(r.outline.plannedDetailThrough, 3)
})

test('模型编造不存在的伏笔 id 时只丢该条并留下警告，其余照常提交', async () => {
  const { applyRollingWindowPlan } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const base = { id: 'p_w2', headVersion: 1, editRevision: 1, targetChapters: 3, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 1, foreshadows: [{ id: 'f1', seed: 's', payoff: 'p', plantChapter: 1, payoffChapter: 3 }],
      volumes: [{ title: '卷一', chapters: [
        { no: 1, title: '已细化' }, { no: 2, title: '待细化', pendingDetail: true },
        { no: 3, title: '待细化', pendingDetail: true }] }] } }
  const proposals = [
    { title: 'w2', cast: [hero.id], foreshadows: [{ id: 'f9', action: 'plant' }] },
    { title: 'w3', cast: [hero.id], foreshadows: [{ id: 'f1', action: 'pay_off' }] },
  ]
  const { project: r, warnings } = applyRollingWindowPlan(base, proposals,
    { expectedHeadVersion: 1, expectedEditRevision: 1, fromNo: 2 })
  assert.deepEqual(r.outline.volumes[0].chapters.find((c) => c.no === 2).foreshadows, [])
  assert.ok(warnings.some((w) => w.includes('f9')), `应记录被忽略的 f9，实际 ${JSON.stringify(warnings)}`)
  // 模型无权自我批准回收
  assert.deepEqual(r.outline.volumes[0].chapters.find((c) => c.no === 3).foreshadows,
    [{ id: 'f1', action: 'pay_off', approved: false }])
})

// 「细化下一组」必须从已细化区之后**连续**补，否则会留下「第 N 章已细化、第 N-1 章还是占位」的空洞，
// 正文生成时取不到前置计划。
test('滚动窗口必须紧接已细化区，不能跳过前面仍是占位的章节', async () => {
  const { applyRollingWindowPlan } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const base = { id: 'p_gap', headVersion: 1, editRevision: 1, targetChapters: 9, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 2, foreshadows: [], volumes: [{ title: '卷一',
      chapters: Array.from({ length: 9 }, (_, i) => ({ no: i + 1, title: i < 2 ? '已细化' : '待细化', ...(i < 2 ? {} : { pendingDetail: true }) })) }] } }
  const proposals = [{ title: 'w7', cast: [hero.id], foreshadows: [] }]
  assert.throws(() => applyRollingWindowPlan(base, proposals,
    { expectedHeadVersion: 1, expectedEditRevision: 1, fromNo: 7 }), /连续细化/)
  const ok = applyRollingWindowPlan(base, proposals, { expectedHeadVersion: 1, expectedEditRevision: 1, fromNo: 3 })
  assert.equal(ok.project.outline.plannedDetailThrough, 3)
})

// 「名字中间被模型插了个空格」「英文名大小写不一致」是同一族漂移。
// 只 trim 不做 canon 时，这类 cast 会被当成「不存在的角色」白丢。
test('cast 写成「林 奇」这种带空格的漂移也能归一', async () => {
  const { applyRollingWindowPlan } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const base = { id: 'p_ws', headVersion: 1, editRevision: 1, targetChapters: 3, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 1, foreshadows: [], volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '已细化' }, { no: 2, title: '待细化', pendingDetail: true },
      { no: 3, title: '待细化', pendingDetail: true }] }] } }
  const proposals = [
    { title: 'w2', cast: ['林 舟'], foreshadows: [] },
    { title: 'w3', cast: [hero.id.toUpperCase()], foreshadows: [] },
  ]
  const { project: r, warnings } = applyRollingWindowPlan(base, proposals,
    { expectedHeadVersion: 1, expectedEditRevision: 1, fromNo: 2 })
  assert.deepEqual(r.outline.volumes[0].chapters.find((c) => c.no === 2).cast, [hero.id])
  assert.deepEqual(r.outline.volumes[0].chapters.find((c) => c.no === 3).cast, [hero.id])
  assert.equal(warnings.length, 0, '能归一就不该报警告')
})

test('重排任务调用模型后只提交未来章节，不改已有正文', async () => {
  const { createReplanService } = await import('../server/replan.js')
  const original = p(), projects = new Map([[original.id, structuredClone(original)]]), runs = new Map()
  const repo = { getProject: (id) => structuredClone(projects.get(id)), saveProject: (x) => projects.set(x.id, structuredClone(x)),
    getRun: (id) => structuredClone(runs.get(id) || null), saveRun: (r) => runs.set(r.id, structuredClone(r)), listRuns: () => [...runs.values()] }
  let calls = 0
  const engine = createReplanService({ repo, config: () => ({pricing: null}), model: async () => {
    calls++
    return { text: JSON.stringify({chapters: [
      {title:'新2',cast:[original.entities[0].id],foreshadows:[]},
      {title:'新3',cast:[original.entities[0].id],foreshadows:[]},
      {title:'新4',cast:[original.entities[0].id],foreshadows:[]},
    ]}), usage:{inputTokens:200,outputTokens:100}, finishReason:'stop' }
  } })
  const r=engine.create(original.id)
  await engine.process(r.id)
  assert.equal(engine.getRun(r.id).status, 'committed')
  assert.equal(calls, 1)
  assert.equal(projects.get(original.id).chapters[0].text, '林舟在门外等候。')
  assert.equal(projects.get(original.id).outline.totalChapters, 4)
})

// 任务 id 是确定性哈希 ⇒ 同一次修订下重复点「细化下一组」命中同一个 run。
// 路由只在 `status==='queued'` 时才触发 process()，所以失败 run 必须被**重置为 queued**，
// 否则用户点「细化下一组」只看到上次的报错、什么都不会发生（这正是截图里的体验）。
test('失败的任务再次创建时重置为 queued，让「再点一次」等于重试', async () => {
  const { createReplanService } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const proj = { id: 'p_retry', headVersion: 1, editRevision: 1, targetChapters: 3, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 1, foreshadows: [], volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '已细化' }, { no: 2, title: '待细化', pendingDetail: true },
      { no: 3, title: '待细化', pendingDetail: true }] }] } }
  const projects = new Map([[proj.id, structuredClone(proj)]]), runs = new Map()
  const repo = { getProject: (id) => structuredClone(projects.get(id)), saveProject: (x) => projects.set(x.id, structuredClone(x)),
    getRun: (id) => structuredClone(runs.get(id) || null), saveRun: (r) => runs.set(r.id, structuredClone(r)), listRuns: () => [...runs.values()] }
  let attempts = 0
  const engine = createReplanService({ repo, config: () => ({ pricing: null }), model: async () => {
    attempts++
    if (attempts === 1) throw new Error('滚动规划的伏笔引用非法')   // 第一次失败
    return { text: JSON.stringify({ chapters: [
      { title: 'w2', cast: [hero.id], foreshadows: [] },
      { title: 'w3', cast: [hero.id], foreshadows: [] },
    ] }), usage: {}, finishReason: 'stop' }
  } })

  const first = engine.create(proj.id, { mode: 'window' })
  const failed = await engine.process(first.id)
  assert.equal(failed.status, 'needs_input')
  assert.match(failed.error, /伏笔引用非法/)

  // 再点一次同一个按钮：create 必须给出可执行的任务（queued），而不是原样返回失败态
  const again = engine.create(proj.id, { mode: 'window' })
  assert.equal(again.id, first.id, '确定性 id 不变（否则会重复计费）')
  assert.equal(again.status, 'queued', '失败态必须被重置为 queued，路由才会触发 process')
  assert.equal(again.error, null, '重置时清掉旧错误，界面不该再显示上次的报错')

  const done = await engine.process(again.id)
  assert.equal(done.status, 'committed', `重试应成功，实际 ${done.status}（${done.error || ''}）`)
  assert.equal(projects.get(proj.id).outline.plannedDetailThrough, 3)
})

// 进行中的任务不能被 create 打回 queued（否则界面会看起来「回退了」）。
test('正在执行的任务再次创建时原样返回，不回退状态', async () => {
  const { createReplanService } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const proj = { id: 'p_inflight', headVersion: 1, editRevision: 1, targetChapters: 3, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 1, foreshadows: [], volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '已细化' }, { no: 2, title: '待细化', pendingDetail: true },
      { no: 3, title: '待细化', pendingDetail: true }] }] } }
  const runs = new Map()
  const repo = { getProject: () => structuredClone(proj), saveProject: () => {},
    getRun: (id) => structuredClone(runs.get(id) || null), saveRun: (r) => runs.set(r.id, structuredClone(r)), listRuns: () => [...runs.values()] }
  const engine = createReplanService({ repo, config: () => ({ pricing: null }), model: async () => ({ text: '{}', usage: {} }) })
  const r = engine.create(proj.id, { mode: 'window' })
  const mid = repo.getRun(r.id); mid.status = 'planning'; mid.step = 'chunk-saved'; repo.saveRun(mid)
  const again = engine.create(proj.id, { mode: 'window' })
  assert.equal(again.status, 'planning', '进行中的任务不该被重置')
})

// 主人的真实现场：任务停在 needs_input + step=chunk-saved。
// 此时 proposals 里可能已经存好了一批**带写法漂移**的章节，点「恢复规划」必须能接着跑通，
// 而不是把漂移当成致命错误再拒一次。
test('停在 chunk-saved 的任务恢复后能带着漂移 proposals 提交成功', async () => {
  const { createReplanService } = await import('../server/replan.js')
  const hero = makeEntity({ name: '林舟', authorRole: '主角' })
  const proj = { id: 'p_resume', headVersion: 1, editRevision: 1, targetChapters: 3, entities: [hero], chapters: [],
    ledger: emptyLedger(),
    outline: { plannedDetailThrough: 1, foreshadows: [{ id: 'f1', seed: 's', payoff: 'p', plantChapter: 2, payoffChapter: 3 }],
      volumes: [{ title: '卷一', chapters: [
        { no: 1, title: '已细化' }, { no: 2, title: '待细化', pendingDetail: true },
        { no: 3, title: '待细化', pendingDetail: true }] }] } }
  const projects = new Map([[proj.id, structuredClone(proj)]]), runs = new Map()
  const repo = { getProject: (id) => structuredClone(projects.get(id)), saveProject: (x) => projects.set(x.id, structuredClone(x)),
    getRun: (id) => structuredClone(runs.get(id) || null), saveRun: (r) => runs.set(r.id, structuredClone(r)), listRuns: () => [...runs.values()] }
  const engine = createReplanService({ repo, config: () => ({ pricing: null }),
    model: async () => ({ text: JSON.stringify({ chapters: [] }), usage: {}, finishReason: 'stop' }) })

  const created = engine.create(proj.id, { mode: 'window' })
  // 手工把它摆成「上一轮失败」的样子：已存好一批带漂移的 proposals，状态 needs_input
  const broken = repo.getRun(created.id)
  broken.status = 'needs_input'; broken.step = 'chunk-saved'; broken.error = '滚动规划的伏笔引用非法'
  broken.proposals = [
    { title: 'w2', cast: ['林舟'], foreshadows: [{ id: 'F1', action: '埋下' }] },
    { title: 'w3', cast: [hero.id], foreshadows: [{ id: 'f1', action: 'pay_off' }] },
  ]
  repo.saveRun(broken)

  const done = await engine.resume(created.id)
  assert.equal(done.status, 'committed', `恢复后应提交成功，实际 ${done.status}（${done.error || ''}）`)
  assert.equal(done.error, null, '成功路径必须清掉旧的 error 文案')
  assert.equal(done.step, 'committed')
  const chs = projects.get(proj.id).outline.volumes.flatMap((v) => v.chapters)
  assert.deepEqual(chs.find((c) => c.no === 2).foreshadows, [{ id: 'f1', action: 'plant', approved: true }])
  assert.deepEqual(chs.find((c) => c.no === 3).foreshadows, [{ id: 'f1', action: 'pay_off', approved: false }])
  assert.equal(projects.get(proj.id).outline.plannedDetailThrough, 3)
})

/* --------- 第二轮全量压测现场：模型把 pay_off 排到与声明不符的章 ⇒ 那章永久写不出来 --------- */
/**
 * 现场（v2.0.0 第二轮压测，《风起处见线》真实付费 6 章）：模型为 f3 排了 `pay_off` 到**第 7 章**，
 * 而 f3 自己声明的回收章是**第 16 章**（差 9 章）。同批 9 条 pay_off 里 **6 条**错位
 * （第 7/23/26/28/29/30 章）。`revealDecision()` 判 `wrong-chapter`
 * ⇒ `projectForeshadows()` 永远 deny ⇒ 第 7 章在**模型调用之前**被拦死
 * ⇒ 「写到回收章就永久卡死」（与第一轮同一个病，但成因不同：这次不是缺审批，是**排期错位**）。
 *
 * 根因：`replanMessages` 里虽然列了「收:16」，那只是**信息**不是**约束**；
 * 且 `applyFuturePlan`（full 模式）连铺设侧自检都没有。
 *
 * 修法：两条路径共用 `downgradeMisplacedPayoffs`，把错位章的 `pay_off` **就地降级为 `reinforce`**：
 *   · 该章因此能正常写作（不再被错位指令拖死）；
 *   · 降级**绝不等于授权** —— `revealDecision()` 要的是 `action==='pay_off' && approved`，
 *     降级后天然不满足；伏笔自己的声明也**一字未改**；
 *   · 记一条明确警告，作者看得见「模型排错了，已降级」。
 */
function withForeshadow(revealAt) {
  const base = p()
  base.outline.foreshadows = [{ id: 'f1', seed: '桌上的旧信', payoff: '写信人是主角自己', linkStatus: 'explicit',
    plantChapter: 1, payoffChapter: revealAt, lifecycle: 'planted' }]
  return base
}

test('重排：pay_off 排到与声明不符的章 ⇒ 自动降级为 reinforce，该章不再被拦死', () => {
  const old = withForeshadow(16)      // 声明第 16 章回收
  const hero = old.entities[0]
  // 模型把回收排到了第 2 章（错位 14 章）
  const proposed = [
    { title: '第二', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [{ id: 'f1', action: 'pay_off' }] },
    { title: '第三', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [] },
    { title: '第四', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [] },
  ]
  const { project: r, warnings } = applyFuturePlan(old, proposed, { expectedHeadVersion: 1, expectedEditRevision: 2 })
  const ch2 = r.outline.volumes.flatMap((v) => v.chapters).find((c) => c.no === 2)
  const act = ch2.foreshadows.find((a) => a.id === 'f1')
  assert.equal(act.action, 'reinforce', '错位的 pay_off 必须降级')
  assert.ok(!(act.action === 'pay_off' && act.approved), '降级后绝不能构成回收授权')
  assert.ok(warnings.some((w) => w.includes('f1') && w.includes('第 16 章')), '必须留下可查的警告')
})

test('重排：排到正确回收章的 pay_off 保持原样（不能被一刀切降级）', () => {
  const old = withForeshadow(2)       // 声明第 2 章回收
  const hero = old.entities[0]
  const proposed = [
    { title: '第二', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [{ id: 'f1', action: 'pay_off' }] },
    { title: '第三', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [] },
    { title: '第四', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [] },
  ]
  const { project: r } = applyFuturePlan(old, proposed, { expectedHeadVersion: 1, expectedEditRevision: 2 })
  const ch2 = r.outline.volumes.flatMap((v) => v.chapters).find((c) => c.no === 2)
  const act = ch2.foreshadows.find((a) => a.id === 'f1')
  assert.equal(act.action, 'pay_off', '位置正确就保留 pay_off')
  assert.equal(act.approved, false, '但模型仍无权自我批准 —— 降级逻辑不得顺带授了权')
})

test('重排：没声明回收章的伏笔排了 pay_off 不降级（交给门禁判 no-explicit-action）', () => {
  const old = p()
  old.outline.foreshadows = [{ id: 'f1', seed: 'x', payoff: 'y', linkStatus: 'explicit', lifecycle: 'planted' }]
  const hero = old.entities[0]
  const proposed = [
    { title: '第二', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [{ id: 'f1', action: 'pay_off' }] },
    { title: '第三', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [] },
    { title: '第四', summary: 'x', goal: 'y', cast: [hero.id], foreshadows: [] },
  ]
  const { project: r, warnings } = applyFuturePlan(old, proposed, { expectedHeadVersion: 1, expectedEditRevision: 2 })
  const ch2 = r.outline.volumes.flatMap((v) => v.chapters).find((c) => c.no === 2)
  assert.equal(ch2.foreshadows.find((a) => a.id === 'f1').action, 'pay_off')
  assert.equal(warnings.filter((w) => w.includes('f1')).length, 0, '没有声明回收章 ⇒ 不属于「错位」')
})
