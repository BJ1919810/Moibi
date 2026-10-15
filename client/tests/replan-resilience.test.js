import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplanService } from '../server/replan.js'
import { emptyLedger } from '../server/schema.js'

/**
 * 重排的两条「韧性」边界 —— 全部来自 2026-10-13 第四轮真实压测（《搬物记事》，综漫快穿）。
 *
 * 那一轮在第 3 章后点「细化下一组」，一次性暴露了三个真 bug，而且都在同一条链上：
 *   ① `parsed.chapters.length !== count`（**精确相等**）⇒ 模型交 3 章而不是 5 章就整个任务失败；
 *   ② 失败的 run 停在 `needs_input`，而 `create()` 的并行保护用的是**黑名单**
 *      （只排除 committed/cancelled/failed/stale）⇒ 那个停住的任务把该作品的**所有重排永久锁死**；
 *   ③ 失败路径 `getRun(id)` 是**读盘**的，而那次**已经付费**的用量只在内存里 push 过、没落盘
 *      ⇒ 用量凭空消失（界面看不到这笔钱，且 `assertCostBudget` 的累计被漏掉，熔断可被绕过）。
 *
 * 三者叠加的现场：细化失败 ⇒ 全局重排「已有正在执行的任务」⇒ `pendingReplan` 一直是 true
 * ⇒ 第 4～8 章全部被拦 ⇒ **作品彻底写不动，界面上没有任何出路**。
 */

const hero = { id: 'ent_hero', kind: 'character', name: '搬运工', aliases: [] }

/** 一卷：第 1 章已细化，第 2..6 章待细化（窗口 = 5 章）。 */
const project = (extra = {}) => ({
  id: 'p_win', headVersion: 0, editRevision: 1, targetChapters: 6,
  entities: [hero], chapters: [], ledger: emptyLedger(),
  outline: {
    plannedDetailThrough: 1, foreshadows: [], totalChapters: 6,
    volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '已细化' },
      ...Array.from({ length: 5 }, (_, i) => ({ no: i + 2, title: '待细化', pendingDetail: true })),
    ] }],
  },
  ...extra,
})

function fixture(t, proj = project(), respond) {
  const projects = new Map([[proj.id, structuredClone(proj)]])
  const runs = new Map()
  const repo = {
    getProject: (id) => structuredClone(projects.get(id)),
    saveProject: (x) => projects.set(x.id, structuredClone(x)),
    getRun: (id) => structuredClone(runs.get(id) || null),
    saveRun: (r) => runs.set(r.id, structuredClone(r)),
    listRuns: () => [...runs.values()],
  }
  let calls = 0
  const engine = createReplanService({
    repo, config: () => ({ pricing: null }),
    model: async (opts) => { calls++; return respond(opts, calls) },
  })
  t.after(() => {})
  return { engine, repo, runs, projects, calls: () => calls, proj }
}

const chapters = (n, from = 2) => Array.from({ length: n }, (_, i) => ({
  title: `w${from + i}`, goal: `目标${from + i}`, cast: [hero.id], foreshadows: [],
}))

/* ------------------------- ① 数量门禁 ------------------------- */

test('window：模型只给 3 章（请求 5）也能成功，剩下的继续要', async (t) => {
  // 第一次给 3 章，第二次只缺 2 章、却给了 3 章 ⇒ 同时覆盖「少给」与「多给」两条路径
  const f = fixture(t, project(), () => ({ text: JSON.stringify({ chapters: chapters(3) }), usage: { inputTokens: 100, outputTokens: 50 }, finishReason: 'stop' }))
  const run = f.engine.create('p_win', { mode: 'window' })
  await f.engine.process(run.id)
  const done = f.engine.getRun(run.id)
  assert.equal(done.status, 'committed', `应成功，实际 ${done.status}：${done.error || ''}`)
  assert.equal(f.calls(), 2, '少给的那部分应当再要一次，而不是整个失败')
  assert.equal(done.proposals.length, 5)
  // 第二次请求 2 章、实际拿到 3 章 ⇒ 只取 2 章，并把「多给了」如实写进 warnings
  assert.ok((done.warnings || []).some((w) => w.includes('超出本次请求')), `warnings=${JSON.stringify(done.warnings)}`)
  assert.equal(f.repo.getProject('p_win').outline.plannedDetailThrough, 6, '5 章都细化完 ⇒ 推进到第 6 章')
})

test('window：多给不会撞上 1～5 章的上限（多余的丢掉并留痕，不再整批失败）', async (t) => {
  const f = fixture(t, project(), () => ({ text: JSON.stringify({ chapters: chapters(7) }), usage: {}, finishReason: 'stop' }))
  const run = f.engine.create('p_win', { mode: 'window' })
  await f.engine.process(run.id)
  const done = f.engine.getRun(run.id)
  assert.equal(done.status, 'committed', `实际 ${done.status}：${done.error || ''}`)
  assert.equal(done.proposals.length, 5, '窗口上限 5 章，不能多排')
  assert.equal(f.calls(), 1)
})

test('window：一章都不给才报错（明确、可重试）', async (t) => {
  const f = fixture(t, project(), () => ({ text: JSON.stringify({ chapters: [] }), usage: {}, finishReason: 'stop' }))
  const run = f.engine.create('p_win', { mode: 'window' })
  await f.engine.process(run.id)
  const done = f.engine.getRun(run.id)
  assert.equal(done.status, 'needs_input')
  assert.match(done.error, /没有返回任何章节/)
})

/* ------------------------- ② 停住的任务不锁死 ------------------------- */

test('停住的 needs_input 任务不再永久锁死该作品的重排', async (t) => {
  const f = fixture(t, project({ pendingReplan: true }), () => ({ text: JSON.stringify({ chapters: [] }), usage: {} }))
  // 模拟「上一次细化失败后留下的停住任务」（与本次要建的任务 id 不同）
  const stale = { id: `run_${'a'.repeat(24)}`, type: 'replan', mode: 'window', projectId: 'p_win', status: 'needs_input', error: '重排模型的章节数量与请求不符', proposals: [], usage: [] }
  f.runs.set(stale.id, stale)
  // ⛔ 修之前这里抛「已有正在执行的任务」⇒ pendingReplan 永远清不掉 ⇒ 正文全被拦
  const full = f.engine.create('p_win', { mode: 'full' })
  assert.ok(full && full.id, '应当能建出全局重排任务')
  assert.equal(full.status, 'queued')
})

test('真正在跑的任务仍然要拦住（判据没有放宽过头）', async (t) => {
  const f = fixture(t, project({ pendingReplan: true }), () => ({ text: '{}', usage: {} }))
  f.runs.set(`run_${'b'.repeat(24)}`, { id: `run_${'b'.repeat(24)}`, type: 'replan', mode: 'window', projectId: 'p_win', status: 'writing', proposals: [], usage: [] })
  assert.throws(() => f.engine.create('p_win', { mode: 'full' }), /已有正在执行的任务/)
})

/* ------------------------- ③ 失败调用的用量不能丢 ------------------------- */

test('模型调用失败（JSON 不合法）时，这次已付费的用量仍要落盘', async (t) => {
  const f = fixture(t, project(), () => ({ text: '这不是 JSON', usage: { inputTokens: 1234, outputTokens: 567 }, finishReason: 'stop' }))
  const run = f.engine.create('p_win', { mode: 'window' })
  await f.engine.process(run.id)
  const done = f.engine.getRun(run.id)
  assert.equal(done.status, 'needs_input')
  // store.getRun 是读盘的：不落盘就等于这笔钱从未存在过，熔断也因此可被反复失败绕过
  assert.equal(done.usage.length, 1, `失败调用的用量必须留下，实际 usage=${JSON.stringify(done.usage)}`)
  assert.equal(done.usage[0].inputTokens, 1234)
})
