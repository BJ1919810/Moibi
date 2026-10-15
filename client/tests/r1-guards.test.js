/**
 * R1 验收测试：安全边界、时间边界、可信度隔离。
 *
 * 对应第 2 轮评审给出的验收标准：
 *   1. 外部来源不能借本机免鉴权访问付费与配置接口
 *   2. 空出场名单不能退化成全角色投影（三态必须严格区分）
 *   3. 第 3 章不能读取第 26 章才发生的事实、状态或认知
 *   4. 缺少可信来源的记录不能作为正式事实进入正文
 *   5. 当前章可用的必要事实不会因为时间过滤被错误移除
 *
 * 另含共同原则的回归：任何 unknown / unverified / needsReview / truncated
 * 都必须产生可观察的运行行为，而不是只在 Schema 里多一个字段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkOrigin, isAuthorized } from '../server/auth.js'
import {
  makeEntity,
  makeFact,
  makeState,
  makeKnowledge,
  makeThread,
  emptyLedger,
  validateProject,
  TRUST,
} from '../server/schema.js'
import { selectContext, effectiveTrust, isVisibleAt } from '../server/ledger.js'
import { buildWriterPacket, renderWriterPacket, resolveCast, CAST_STATUS } from '../server/projection.js'

/* ================================ fixture ================================
   一部 34 章规模的作品：
     第 3 章  —— 当前章（编译对象）
     第 26 章 —— 未来章，任何内容都不得对第 3 章可见
   ======================================================================= */

function makeProject(overrides = {}) {
  const shen = makeEntity({ name: '沈砚', publicRole: '文书修复员', authorRole: '主角' })
  const gu = makeEntity({
    name: '顾行舟',
    publicRole: '志愿者',
    authorRole: '对手',
    secret: '实为林晚之子',
  })
  const song = makeEntity({ name: '宋瓷', publicRole: '记者', authorRole: '配角' })

  const chapters = []
  for (let no = 1; no <= 34; no++) {
    chapters.push({
      no,
      title: `第${no}章`,
      summary: `第 ${no} 章的概要`,
      goal: `第 ${no} 章的目标`,
      cast: no === 3 ? [shen.id, gu.id] : [shen.id],
      foreshadows: [],
    })
  }

  return {
    id: 'p_r1',
    title: 'R1 验收',
    genre: '悬疑',
    entities: [shen, gu, song],
    ledger: emptyLedger(),
    outline: {
      logline: '一句话',
      theme: '主题',
      style: '第三人称限知',
      cast: [{ name: '沈砚', entityId: shen.id }],
      foreshadows: [],
      volumes: [{ title: '卷一', goal: '', chapters }],
    },
    chapters: [],
    _ids: { shen: shen.id, gu: gu.id, song: song.id },
    ...overrides,
  }
}

/* ==================== 1. 同源校验（P0-0 复审） ==================== */

test('同源请求放行', () => {
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' }).ok, true)
  assert.equal(checkOrigin({ origin: 'http://192.168.1.5:8787', host: '192.168.1.5:8787' }).ok, true)
  assert.equal(checkOrigin({ origin: 'http://localhost:8787', host: 'localhost:8787' }).ok, true)
})

test('跨源请求被拒绝', () => {
  const r = checkOrigin({ origin: 'https://evil.example', host: '127.0.0.1:8787' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cross-origin')
})

test('端口不同也算跨源', () => {
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:8787' }).ok, false)
})

test('域名相似但不同被拒绝（前缀欺骗）', () => {
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1.evil.com', host: '127.0.0.1' }).ok, false)
})

test('opaque origin（file:// 与沙箱 iframe）被拒绝', () => {
  const r = checkOrigin({ origin: 'null', host: '127.0.0.1:8787' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'opaque-origin')
})

test('畸形 Origin 被拒绝', () => {
  assert.equal(checkOrigin({ origin: 'not a url', host: '127.0.0.1:8787' }).ok, false)
})

test('缺少 Host 时拒绝', () => {
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1:8787', host: '' }).ok, false)
})

test('无 Origin 头放行（curl / 脚本 / 同源导航）', () => {
  assert.equal(checkOrigin({ origin: undefined, host: '127.0.0.1:8787' }).ok, true)
})

test('本机免鉴权只在同源下成立：跨源来源既非本机也拿不到口令 → 双重拒绝', () => {
  // 攻击场景：本机浏览器里的恶意页面请求 127.0.0.1:8787
  const fromLocalMachine = '127.0.0.1'
  // 口令校验会放行（本机免检）……
  assert.equal(isAuthorized({ remoteAddress: fromLocalMachine, expected: 'secret' }), true)
  // ……但同源校验必须拦下它，两者叠加才构成完整防护
  assert.equal(checkOrigin({ origin: 'https://evil.example', host: '127.0.0.1:8787' }).ok, false)
})

/* ==================== 2. 空出场名单的三态 ==================== */

test('三态之一：cast 字段缺失 → unknown，只投影主角', () => {
  const p = makeProject()
  const meta = { no: 5, title: 't', cast: undefined }
  delete meta.cast
  const r = resolveCast(meta, p)
  assert.equal(r.status, CAST_STATUS.UNKNOWN)
  assert.deepEqual([...r.ids], [p._ids.shen])
})

test('三态之二：cast 明确为空数组 → none，只投影主角', () => {
  const p = makeProject()
  const r = resolveCast({ no: 5, cast: [] }, p)
  assert.equal(r.status, CAST_STATUS.NONE)
  assert.deepEqual([...r.ids], [p._ids.shen])
})

test('三态之三：cast 明确列出 → limited，主角 + 指定人物', () => {
  const p = makeProject()
  const r = resolveCast({ no: 5, cast: [p._ids.gu] }, p)
  assert.equal(r.status, CAST_STATUS.LIMITED)
  assert.ok(r.ids.has(p._ids.shen))
  assert.ok(r.ids.has(p._ids.gu))
  assert.ok(!r.ids.has(p._ids.song))
})

test('三种状态互不相同（unknown / none / limited 是三个含义）', () => {
  const vals = new Set([CAST_STATUS.UNKNOWN, CAST_STATUS.NONE, CAST_STATUS.LIMITED])
  assert.equal(vals.size, 3)
})

test('空 cast 不再退化为全部角色（回到第 2 轮评审问题 3）', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 3) // 该章 cast 被 fixture 改空
  // 先确认 fixture 生效，再断言
  const meta = p.outline.volumes[0].chapters.find((c) => c.no === 3)
  meta.cast = [] // 模拟真实数据里的第 22 章
  const pkt = buildWriterPacket(p, 3)
  assert.equal(pkt.diagnostics.castStatus, CAST_STATUS.NONE)
  assert.equal(pkt.cast.length, 1)
  assert.equal(pkt.cast[0].name, '沈砚')
  assert.ok(!pkt.cast.some((c) => c.name === '宋瓷'))
  assert.ok(!pkt.cast.some((c) => c.name === '顾行舟'))
  assert.ok(packet) // 前面的调用未抛错
})

test('cast 引用不存在的实体 → 阻断编译', () => {
  const p = makeProject()
  p.outline.volumes[0].chapters.find((c) => c.no === 3).cast = ['ent_deadbeef00']
  assert.throws(() => buildWriterPacket(p, 3), /不存在的实体/)
})

test('unknown 状态的限制会写进提示词（不只是 Schema 字段）', () => {
  const p = makeProject()
  delete p.outline.volumes[0].chapters.find((c) => c.no === 3).cast
  const packet = buildWriterPacket(p, 3)
  const text = renderWriterPacket(packet)
  assert.match(text, /未提供出场名单/)
  assert.equal(packet.diagnostics.castStatus, CAST_STATUS.UNKNOWN)
})

/* ==================== 3. 时间边界 ==================== */

test('isVisibleAt：晚于当前章的记录不可见', () => {
  assert.equal(isVisibleAt({ sourceChapter: 26 }, { chapterNo: 3 }).visible, false)
  assert.equal(isVisibleAt({ sourceChapter: 3 }, { chapterNo: 3 }).visible, true)
  assert.equal(isVisibleAt({ sourceChapter: 2 }, { chapterNo: 3 }).visible, true)
})

test('isVisibleAt：保留故事时间接口（storyTime 优先级高于章节）', () => {
  const e = { sourceChapter: 3, storyTime: 50 }
  assert.equal(isVisibleAt(e, { chapterNo: 3, storyTime: 40 }).visible, false)
  assert.equal(isVisibleAt(e, { chapterNo: 3, storyTime: 60 }).visible, true)
})

test('第 3 章读不到第 26 章才发生的事实', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '第26章才揭晓的真相', entityIds: [p._ids.shen], sourceChapter: 26 }),
    makeFact({ text: '第3章就知道的事', entityIds: [p._ids.shen], sourceChapter: 3 })
  )
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  const texts = ctx.facts.map((f) => f.text)
  assert.ok(texts.includes('第3章就知道的事'))
  assert.ok(!texts.includes('第26章才揭晓的真相'))
  assert.equal(ctx.diagnostics.futureSkipped.facts, 1)
})

test('第 3 章读不到第 26 章才生效的状态', () => {
  const p = makeProject()
  p.ledger.currentState.push(
    makeState({ subjectId: p._ids.shen, attribute: '伤势', value: '重伤', sinceChapter: 26 }),
    makeState({ subjectId: p._ids.shen, attribute: '位置', value: '档案馆', sinceChapter: 2 })
  )
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  assert.ok(ctx.states.some((s) => s.attribute === '位置'))
  assert.ok(!ctx.states.some((s) => s.attribute === '伤势'))
  assert.equal(ctx.diagnostics.futureSkipped.states, 1)
})

test('第 3 章读不到第 26 章才产生的认知', () => {
  const p = makeProject()
  p.ledger.characterKnowledge.push(
    makeKnowledge({ characterId: p._ids.shen, fact: '后来才知道的事', belief: 'knows', sinceChapter: 26 }),
    makeKnowledge({ characterId: p._ids.shen, fact: '早就知道的事', belief: 'suspects', sinceChapter: 2 })
  )
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  assert.ok(ctx.knowledge.some((k) => k.fact === '早就知道的事'))
  assert.ok(!ctx.knowledge.some((k) => k.fact === '后来才知道的事'))
  assert.equal(ctx.diagnostics.futureSkipped.knowledge, 1)
})

test('未了结线索同样受时间边界约束', () => {
  const p = makeProject()
  p.ledger.plotThreads.push(
    makeThread({ text: '未来的线索', sourceChapter: 26 }),
    makeThread({ text: '当前的线索', sourceChapter: 2 })
  )
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  assert.ok(ctx.threads.some((t) => t.text === '当前的线索'))
  assert.ok(!ctx.threads.some((t) => t.text === '未来的线索'))
})

test('端到端：第 3 章的 WriterPacket 不含第 26 章事实', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '第26章才揭晓的真相', entityIds: [p._ids.shen], sourceChapter: 26 })
  )
  const packet = buildWriterPacket(p, 3)
  assert.ok(!packet.context.facts.includes('第26章才揭晓的真相'))
  assert.match(renderWriterPacket(packet), /^[\s\S]*$/) // 渲染不报错
})

/* ==================== 4. 可信度隔离 ==================== */

test('effectiveTrust：有出处即可信', () => {
  assert.equal(effectiveTrust({ sourceChapter: 5 }), TRUST.CANONICAL)
  assert.equal(effectiveTrust({ sinceChapter: 5 }), TRUST.CANONICAL)
})

test('effectiveTrust：无出处一律隔离（默认值也是行为，不是装饰）', () => {
  assert.equal(effectiveTrust({ text: 'x' }), TRUST.LEGACY_UNVERIFIED)
  assert.equal(effectiveTrust({ sourceChapter: null }), TRUST.LEGACY_UNVERIFIED)
})

test('effectiveTrust：显式 trust 优先于推断', () => {
  assert.equal(effectiveTrust({ sourceChapter: 5, trust: TRUST.LEGACY_UNVERIFIED }), TRUST.LEGACY_UNVERIFIED)
  assert.equal(effectiveTrust({ trust: TRUST.NEEDS_REVIEW }), TRUST.NEEDS_REVIEW)
})

test('legacy_unverified 的事实不进入正文上下文，且被计入隔离清单', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '旧账本里的待验证事实', trust: TRUST.LEGACY_UNVERIFIED, sourceChapter: null })
  )
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  assert.ok(!ctx.facts.some((f) => f.text === '旧账本里的待验证事实'))
  assert.equal(ctx.diagnostics.quarantined.facts.length, 1)
})

test('needsReview 的记录同样被隔离', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '模型推断待复核', trust: TRUST.NEEDS_REVIEW, sourceChapter: 2 })
  )
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  assert.ok(!ctx.facts.some((f) => f.text === '模型推断待复核'))
})

test('迁移出来的旧事实（verified:false + 无出处）无法进入第 3 章 WriterPacket', () => {
  const p = makeProject()
  const legacy = makeFact({
    text: '迁移得到的旧事实',
    entityIds: [p._ids.shen],
    sourceChapter: null,
    verified: false,
    trust: TRUST.LEGACY_UNVERIFIED,
  })
  p.ledger.canonicalFacts.push(legacy)
  const packet = buildWriterPacket(p, 3)
  assert.ok(!packet.context.facts.includes('迁移得到的旧事实'))
  assert.equal(packet.diagnostics.quarantined.facts.length, 1)
  assert.ok(packet.diagnostics.summary.some((s) => /隔离/.test(s)))
})

test('隔离仅影响上下文，不影响存储（旧数据必须留在账本里）', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '保留在存储层', trust: TRUST.LEGACY_UNVERIFIED, sourceChapter: null })
  )
  selectContext(p, { chapterNo: 3, entityIds: [p._ids.shen] })
  assert.equal(p.ledger.canonicalFacts.length, 1)
})

/* ==================== 5. 必要事实不被错误移除 ==================== */

test('requiredIds 指定的必需事实即使排在最后也必入选', () => {
  const p = makeProject()
  const early = makeFact({ text: '第1章的关键事实', entityIds: [p._ids.shen], sourceChapter: 1 })
  p.ledger.canonicalFacts.push(early)
  for (let i = 2; i <= 40; i++) {
    p.ledger.canonicalFacts.push(
      makeFact({ text: `第${i}章事实`, entityIds: [p._ids.shen], sourceChapter: i })
    )
  }
  const ctx = selectContext(p, {
    chapterNo: 41,
    entityIds: [p._ids.shen],
    requiredIds: [early.id],
    budget: { maxFacts: 5 },
  })
  assert.ok(ctx.facts.some((f) => f.id === early.id), '必需事实被截断丢弃了')
})

test('必需事实若因时间边界不可见 → 进 requiredMissing，不静默忽略', () => {
  const p = makeProject()
  const future = makeFact({ text: '未来章的事实', entityIds: [p._ids.shen], sourceChapter: 26 })
  p.ledger.canonicalFacts.push(future)
  const ctx = selectContext(p, {
    chapterNo: 3,
    entityIds: [p._ids.shen],
    requiredIds: [future.id],
  })
  assert.deepEqual(ctx.diagnostics.requiredMissing, [future.id])
  assert.ok(ctx.diagnostics.summary.some((s) => /必需记录不可用/.test(s)))
})

/* ==================== 6. 截断必须报告（不静默） ==================== */

test('超预算时 dropppedIds 必须报告，且晚期事实优先保留', () => {
  const p = makeProject()
  for (let i = 1; i <= 40; i++) {
    p.ledger.canonicalFacts.push(
      makeFact({ text: `第${i}章事实`, entityIds: [p._ids.shen], sourceChapter: i })
    )
  }
  const ctx = selectContext(p, { chapterNo: 41, entityIds: [p._ids.shen], budget: { maxFacts: 30 } })
  assert.equal(ctx.facts.length, 30)
  assert.equal(ctx.diagnostics.truncated.facts.droppedIds.length, 10)
  // 晚期新事实优先：第 40 章那条必须入选
  assert.ok(ctx.facts.some((f) => f.sourceChapter === 40))
  // 被丢掉的是最早的
  assert.ok(!ctx.facts.some((f) => f.sourceChapter === 1))
})

test('truncated 摘要出现在 diagnostics.summary 里', () => {
  const p = makeProject()
  for (let i = 1; i <= 40; i++) {
    p.ledger.canonicalFacts.push(
      makeFact({ text: `第${i}章事实`, entityIds: [p._ids.shen], sourceChapter: i })
    )
  }
  const ctx = selectContext(p, { chapterNo: 41, entityIds: [p._ids.shen], budget: { maxFacts: 30 } })
  assert.ok(ctx.diagnostics.summary.some((s) => /超预算截断/.test(s)))
})

/* ==================== 7. 标记合法性 ==================== */

test('validateProject 检出非法 trust 取值', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push({ id: 'fact_x', text: 'x', entityIds: [], trust: 'whatever' })
  const issues = validateProject(p)
  assert.ok(issues.some((s) => /trust 取值非法/.test(s)))
})

test('validateProject 检出空的伏笔 ID', () => {
  const p = makeProject()
  p.outline.foreshadows = [{ id: '', seed: '一个没有 ID 的伏笔' }]
  const issues = validateProject(p)
  assert.ok(issues.some((s) => /没有 id 的伏笔/.test(s)))
})

test('validateProject 对合规项目返回空数组', () => {
  const p = makeProject()
  assert.deepEqual(validateProject(p), [])
})
