/**
 * 状态转移引擎测试（R2）
 *
 * 前三个是评审指定的**必测场景**，比几十条正常路径更重要：
 *   1. 同章往返    主角一天内 A→B→A，两个 A 对应不同事件，最终只有最后一次 A 有效
 *   2. 失败回滚    一组变化中第三项违反前置条件，整组不得部分生效
 *   3. 重复处理    同一批事件连续执行两次，结果与执行一次完全一致
 * 其余覆盖跨章往返、认知演变、历史查询、证据溯源、幂等键与事件 ID 的区分度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyStateChanges,
  planStateChanges,
  queryStateAt,
  queryKnowledgeAt,
  queryStateTimeline,
  queryKnowledgeHistory,
  currentSnapshot,
  queryEvidence,
  queryEventsAtChapter,
  isEffectiveAt,
  VIOLATION,
} from '../server/state-engine.js'
import { emptyLedger, makeEntity, makeState, makeKnowledge } from '../server/schema.js'
import { ensureLedger } from '../server/ledger.js'

/* ========================= fixture ========================= */

function project() {
  const shen = makeEntity({ name: '沈砚' })
  const gu = makeEntity({ name: '顾行舟' })
  const archive = makeEntity({ kind: 'place', name: '档案馆' })
  const bridge = makeEntity({ kind: 'place', name: '青江桥' })
  return {
    id: 'p1',
    entities: [shen, gu, archive, bridge],
    ledger: emptyLedger(),
    outline: { volumes: [] },
    chapters: [],
  }
}

const ids = (p) => Object.fromEntries(p.entities.map((e) => [e.name, e.id]))
const P = '位置'
const HOLD = '持有'

/** 位置变化 */
const move = (p, name, value, sinceChapter) => ({
  kind: 'state',
  subjectId: ids(p)[name],
  attribute: P,
  value,
  sinceChapter,
})

/* ==================== 必测 1：同章往返 ==================== */

test('【必测】同章往返：A→B→A 两个 A 是两条记录两个事件，最终只有最后一次 A 有效', () => {
  const p = project()
  const I = ids(p)
  const shen = I['沈砚']

  // 第 3 章：人在档案馆
  applyStateChanges(p, [move(p, '沈砚', '档案馆', 3)], { chapterNo: 3 })
  assert.equal(p.ledger.currentState.length, 1)

  // 第 5 章：同一天里 档案馆 → 青江桥 → 档案馆，一批提交
  const res = applyStateChanges(
    p,
    [
      move(p, '沈砚', '青江桥', 5),
      move(p, '沈砚', '青江桥', 5), // 内容重复也无妨：序号不同 → 两条记录
      move(p, '沈砚', '档案馆', 5),
    ],
    { chapterNo: 5, batchKey: 'b-ch5' }
  )
  assert.equal(res.ok, true, '一批合法变化应当整批生效')
  assert.equal(res.applied.states, 3)
  assert.equal(res.applied.events, 3)

  // 三条记录 + 第 3 章那条，共四条；两个「档案馆」的 ID 必须不同
  const timeline = queryStateTimeline(p, { subjectId: shen, attribute: P })
  assert.equal(timeline.length, 4)
  const archives = timeline.filter((s) => s.value === '档案馆')
  assert.equal(archives.length, 2)
  assert.notEqual(archives[0].id, archives[1].id, '两次「档案馆」必须是两条不同记录')
  assert.notEqual(archives[0].eventId, archives[1].eventId, '两次「档案馆」必须是两个不同事件')

  // 第 5 章的有效状态只有一个，且是最后一次的「档案馆」
  const at5 = queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 5 })
  assert.equal(at5.length, 1, '同键同章只应有一条有效状态')
  assert.equal(at5[0].value, '档案馆')
  assert.equal(at5[0].id, archives[1].id, '有效的必须是最后那次 A')

  // 第 4 章回看：还是第一次的「档案馆」（第 5 章的变化尚不可见/尚未生效）
  const at4 = queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 4 })
  assert.equal(at4.length, 1)
  assert.equal(at4[0].id, archives[0].id)

  // 事件按序留有完整链：from → to 首尾相接
  const evs = queryEventsAtChapter(p, 5)
  assert.equal(evs.length, 3)
  assert.equal(evs[0].fromValue, '档案馆')
  assert.equal(evs[0].toValue, '青江桥')
  assert.equal(evs[1].toValue, '青江桥')
  assert.equal(evs[2].fromValue, '青江桥')
  assert.equal(evs[2].toValue, '档案馆')
})

/* ==================== 必测 2：失败回滚 ==================== */

test('【必测】失败回滚：第三项违反前置条件，整组一条都不落', () => {
  const p = project()
  const I = ids(p)
  const shen = I['沈砚']

  applyStateChanges(p, [move(p, '沈砚', '档案馆', 5)], { chapterNo: 5 })
  const before = JSON.parse(JSON.stringify(p.ledger))

  // 第三项把状态时间倒回第 3 章 —— 非法转移
  const res = applyStateChanges(
    p,
    [
      move(p, '沈砚', '青江桥', 6),
      { kind: 'state', subjectId: shen, attribute: HOLD, value: '铜钥匙', sinceChapter: 6 },
      move(p, '沈砚', '荒宅', 3),
    ],
    { chapterNo: 6 }
  )

  assert.equal(res.ok, false, '含非法转移的整批必须被拒绝')
  assert.equal(res.rejected, true)
  assert.ok(
    res.violations.some((v) => v.code === VIOLATION.TIME_REGRESSION.code),
    '应报出时间倒退违规'
  )
  assert.deepEqual(p.ledger, before, '账本必须一字未改，不得部分生效')
  assert.equal(p.ledger.currentState.length, 1)
  assert.equal(p.ledger.stateEvents.length, 1)
  assert.equal(res.applied.states, 0)

  // 去掉非法项后，同批其余内容正常生效
  const ok = applyStateChanges(
    p,
    [move(p, '沈砚', '青江桥', 6), { kind: 'state', subjectId: shen, attribute: HOLD, value: '铜钥匙', sinceChapter: 6 }],
    { chapterNo: 6 }
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.applied.states, 2)
  assert.equal(queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 6 })[0].value, '青江桥')
})

/**
 * 原子性保障：任何 error 级违规都必须让整批作废、账本一字不改。
 *
 * ⚠️ 这条测试的**手段**换过一次，但**意图从未变**：
 *   原本用「缺失取值的状态变化」触发（那时 MISSING_FIELD 是 error）。
 *   后来发现那样太狠 —— 模型从正文提取出「部室柜子发生了变化」却没给属性名，
 *   就会**整章作废**：2353 字正文已生成、钱已花掉、草稿躺在 run 里，
 *   却永远提交不进去，还把整个作品锁死。主人的原则：
 *   「不放行浪费 token 还不给看也太变态了」。
 *   ⇒ MISSING_FIELD 降为 warning（见下方新增测试）。
 *   这里改用**真正会污染别处的** TIME_REGRESSION 来验证同一个原子性。
 */
test('【必测·补充】半途异常不落半成品：时间回退直接拒绝整批', () => {
  const p = project()
  // 先在第 2 章落一个合法值，再试图提交第 1 章的值 ⇒ 时间线倒退
  applyStateChanges(p, [move(p, '沈砚', '青江桥', 2)], { chapterNo: 2 })
  const before = JSON.parse(JSON.stringify(p.ledger))
  const res = applyStateChanges(
    p,
    [
      move(p, '沈砚', '档案馆', 3),
      move(p, '沈砚', '旧邮局', 1),
    ],
    { chapterNo: 1 }
  )
  assert.equal(res.ok, false)
  assert.ok(res.violations.some((v) => v.code === VIOLATION.TIME_REGRESSION.code))
  assert.deepEqual(p.ledger, before)
})

/**
 * 新语义（v2.0.0 修复）：提取残缺只跳这一条，正文照常提交。
 *
 * 真实 run `run_c8e0be16fa8cb747837a7698`（第 2 章，2353 字）卡死在这里：
 * 模型给了 `{subject:'部室柜子'}` 却没给 attribute/value。
 */
test('提取残缺（缺属性/取值）只跳过该条，其余变化照样入账，不整批作废', () => {
  const p = project()
  const res = applyStateChanges(
    p,
    [
      move(p, '沈砚', '档案馆', 1),
      { kind: 'state', subjectId: ids(p)['沈砚'], attribute: P, value: '', sinceChapter: 1 },
    ],
    { chapterNo: 1 }
  )
  assert.equal(res.ok, true, '缺少取值不该让整批作废')
  assert.ok(res.violations.some((v) => v.code === VIOLATION.MISSING_FIELD.code), '仍要如实记录这条残缺')
  assert.equal(res.applied?.changes ?? res.applied?.states ?? 1, 1, '合法的那条要落账')
  assert.equal(queryStateAt(p, { subjectId: ids(p)['沈砚'], attribute: P, chapterNo: 1 })[0].value, '档案馆')
})

test('提取残缺以 warning 记录，可被调用方区分出来如实告知作者', () => {
  const p = project()
  const res = applyStateChanges(p, [{ kind: 'state', subjectId: ids(p)['沈砚'], attribute: '', value: '' }], { chapterNo: 1 })
  const v = res.violations.find((x) => x.code === VIOLATION.MISSING_FIELD.code)
  assert.ok(v, '应记录 missing-field')
  assert.equal(v.severity, 'warning', 'severity 必须是 warning 才能放行')
  assert.equal(VIOLATION.MISSING_FIELD.severity, 'warning')
})

/* ==================== 必测 3：重复处理 ==================== */

test('【必测】重复处理：同一批事件连续执行两次，结果与执行一次完全一致', () => {
  const p = project()
  const batch = [
    move(p, '沈砚', '档案馆', 2),
    { kind: 'state', subjectId: ids(p)['沈砚'], attribute: HOLD, value: '铜钥匙', sinceChapter: 2 },
    { kind: 'knowledge', characterId: ids(p)['顾行舟'], fact: '沈砚拿到了铜钥匙', belief: 'suspects', sinceChapter: 2 },
  ]

  const first = applyStateChanges(p, batch, { chapterNo: 2, batchKey: 'submit-42' })
  assert.equal(first.ok, true)
  const snapshot = JSON.parse(JSON.stringify(p.ledger))
  assert.equal(first.applied.states, 2)
  assert.equal(first.applied.knowledge, 1)
  assert.equal(first.applied.events, 3)

  // 原样再来一次
  const second = applyStateChanges(p, batch, { chapterNo: 2, batchKey: 'submit-42' })
  assert.equal(second.ok, true)
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'duplicate-batch')
  assert.equal(second.applied.events, 0)
  assert.deepEqual(p.ledger, snapshot, '重复提交必须与只执行一次完全一致')

  // 内容相同但**提交标识不同** → 视为同章内确实又发生了一次，序号避让、ID 不撞
  const third = applyStateChanges(p, batch, { chapterNo: 2, batchKey: 'submit-43' })
  assert.equal(third.applied.events, 3, '不同提交标识不应被判为重复')
  const allIds = p.ledger.stateEvents.map((e) => e.id)
  assert.equal(new Set(allIds).size, allIds.length, '事件 ID 不得重复')
  const states = queryStateAt(p, { subjectId: ids(p)['沈砚'], attribute: P, chapterNo: 2 })
  assert.equal(states.length, 1, '同键同章仍只保留一条有效状态')
})

/* ==================== 跨章往返与历史查询 ==================== */

test('跨章往返：档案馆→青江桥→档案馆，可再次进入同一状态且旧状态正确收尾', () => {
  const p = project()
  const shen = ids(p)['沈砚']
  applyStateChanges(p, [move(p, '沈砚', '档案馆', 1)], { chapterNo: 1 })
  applyStateChanges(p, [move(p, '沈砚', '青江桥', 2)], { chapterNo: 2 })
  applyStateChanges(p, [move(p, '沈砚', '档案馆', 3)], { chapterNo: 3 })

  const tl = queryStateTimeline(p, { subjectId: shen, attribute: P })
  assert.equal(tl.length, 3)
  assert.deepEqual(
    tl.map((s) => [s.sinceChapter, s.value, s.status]),
    [
      [1, '档案馆', 'superseded'],
      [2, '青江桥', 'superseded'],
      [3, '档案馆', 'active'],
    ]
  )
  // 旧状态被替代时必须交代：被谁替代、替代于第几章
  assert.equal(tl[0].untilChapter, 2)
  assert.equal(tl[0].supersededBy, tl[1].id)
  assert.equal(tl[2].untilChapter, null)

  // 查询指定章节的有效状态，而不是最新状态
  assert.equal(queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 1 })[0].value, '档案馆')
  assert.equal(queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 2 })[0].value, '青江桥')
  assert.equal(queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 3 })[0].value, '档案馆')
  assert.equal(queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 2 })[0].id, tl[1].id)
})

test('isEffectiveAt：生效章之前不可见、被替代章起失效、无截止则一直有效', () => {
  const rec = makeState({ subjectId: 'ent_a', attribute: P, value: '档案馆', sinceChapter: 5, untilChapter: 9 })
  assert.equal(isEffectiveAt(rec, 4), false)
  assert.equal(isEffectiveAt(rec, 5), true)
  assert.equal(isEffectiveAt(rec, 8), true)
  assert.equal(isEffectiveAt(rec, 9), false)
  const open = makeState({ subjectId: 'ent_a', attribute: P, value: '青江桥', sinceChapter: 5 })
  assert.equal(isEffectiveAt(open, 99), true)
})

/* ==================== 认知演变 ==================== */

test('认知演变：suspects → knows 保留变化历史，当前认知正确更新', () => {
  const p = project()
  const gu = ids(p)['顾行舟']
  const FACT = '沈砚是纵火者'

  applyStateChanges(
    p,
    [{ kind: 'knowledge', characterId: gu, fact: FACT, belief: 'suspects', sinceChapter: 1 }],
    { chapterNo: 1 }
  )
  applyStateChanges(
    p,
    [{ kind: 'knowledge', characterId: gu, fact: FACT, belief: 'believes', sinceChapter: 4 }],
    { chapterNo: 4 }
  )
  applyStateChanges(
    p,
    [{ kind: 'knowledge', characterId: gu, fact: FACT, belief: 'knows', sinceChapter: 9 }],
    { chapterNo: 9 }
  )

  const hist = queryKnowledgeHistory(p, { characterId: gu, fact: FACT })
  assert.equal(hist.length, 3, '变化历史必须完整保留')
  assert.deepEqual(
    hist.map((k) => k.belief),
    ['suspects', 'believes', 'knows']
  )
  assert.deepEqual(
    hist.map((k) => k.status),
    ['superseded', 'superseded', 'active']
  )

  // 当前认知正确更新：每个时点各只有一种看法
  assert.equal(queryKnowledgeAt(p, { characterId: gu, fact: FACT, chapterNo: 1 }).length, 1)
  assert.equal(queryKnowledgeAt(p, { characterId: gu, fact: FACT, chapterNo: 1 })[0].belief, 'suspects')
  assert.equal(queryKnowledgeAt(p, { characterId: gu, fact: FACT, chapterNo: 4 })[0].belief, 'believes')
  assert.equal(queryKnowledgeAt(p, { characterId: gu, fact: FACT, chapterNo: 9 })[0].belief, 'knows')

  // 三种认知是三条不同记录
  assert.equal(new Set(hist.map((k) => k.id)).size, 3)

  // 非法取值不该偷偷改成 knows：按 warning 跳过，其余照常
  const bad = applyStateChanges(
    p,
    [
      { kind: 'knowledge', characterId: gu, fact: '天要下雨', belief: '瞎猜', sinceChapter: 10 },
      { kind: 'knowledge', characterId: gu, fact: '天要下雨', belief: 'knows', sinceChapter: 10 },
    ],
    { chapterNo: 10 }
  )
  assert.equal(bad.ok, true, '非法认知取值是模型噪声，不该拖垮整批')
  assert.ok(bad.plan.warnings.some((w) => w.code === VIOLATION.INVALID_BELIEF.code))
  assert.equal(bad.applied.knowledge, 1)
})

test('无法解析到实体的变化按 warning 跳过，不阻断整批', () => {
  const p = project()
  const res = applyStateChanges(
    p,
    [move(p, '沈砚', '档案馆', 1), { kind: 'state', subjectId: null, subject: '路人甲', attribute: P, value: '荒宅', sinceChapter: 1 }],
    { chapterNo: 1 }
  )
  assert.equal(res.ok, true)
  assert.equal(res.applied.states, 1)
  assert.ok(res.plan.warnings.some((w) => w.code === VIOLATION.UNKNOWN_SUBJECT.code))
})

/* ==================== 证据溯源 ==================== */

test('证据溯源：状态事件能关联来源正文版本与具体位置', () => {
  const p = project()
  const shen = ids(p)['沈砚']
  applyStateChanges(p, [{ ...move(p, '沈砚', '档案馆', 7), sourceSpan: '第 3 段第 2 句', sourceVersion: 12 }], {
    chapterNo: 7,
    batchKey: 'b7',
    sourceVersion: 12,
  })

  const at7 = queryStateAt(p, { subjectId: shen, attribute: P, chapterNo: 7 })[0]
  const ev = queryEvidence(p, { stateId: at7.id })
  assert.equal(ev.sourceChapter, 7)
  assert.equal(ev.sourceVersion, 12)
  assert.equal(ev.sourceSpan, '第 3 段第 2 句')
  assert.equal(ev.event.toValue, '档案馆')

  // 反向：由事件 ID 也能找回记录
  const back = queryEvidence(p, { eventId: at7.eventId })
  assert.equal(back.record.id, at7.id)
})

/* ==================== 三个 ID 各司其职 ==================== */

test('三个 ID 各司其职：内容相同的变化可区分，重复提交可识别', () => {
  const p = project()
  const shen = ids(p)['沈砚']
  applyStateChanges(p, [move(p, '沈砚', '档案馆', 1), move(p, '沈砚', '青江桥', 1), move(p, '沈砚', '档案馆', 1)], {
    chapterNo: 1,
    batchKey: 'b1',
  })

  const tl = queryStateTimeline(p, { subjectId: shen, attribute: P })
  assert.equal(tl.length, 3)
  // state_id：记录身份，两条「档案馆」不同
  assert.notEqual(tl[0].id, tl[2].id)
  // event_id：事件身份，两次「档案馆」不同
  assert.notEqual(tl[0].eventId, tl[2].eventId)
  // idempotency_key：提交身份，三条互不相同
  const iks = (p.ledger.stateEvents || []).map((e) => e.idempotencyKey)
  assert.equal(new Set(iks).size, 3)
  assert.ok(iks.every((k) => k.startsWith('ik_')))
  // 事件 ID 前缀可辨识
  assert.ok(p.ledger.stateEvents.every((e) => e.id.startsWith('ev_')))
})

/* ==================== 规划与提交分离 ==================== */

test('planStateChanges 零副作用：只规划不落库', () => {
  const p = project()
  ensureLedger(p)
  const before = JSON.parse(JSON.stringify(p.ledger))
  const plan = planStateChanges(p, [move(p, '沈砚', '档案馆', 1)], { chapterNo: 1 })
  assert.equal(plan.ok, true)
  assert.equal(plan.newStates.length, 1)
  assert.equal(plan.newEvents.length, 1)
  assert.deepEqual(p.ledger, before, '规划阶段绝不允许改动账本')
})

test('currentSnapshot 给出某一章的完整世界截面', () => {
  const p = project()
  const gu = ids(p)['顾行舟']
  applyStateChanges(p, [move(p, '沈砚', '档案馆', 1)], { chapterNo: 1 })
  applyStateChanges(p, [move(p, '沈砚', '青江桥', 5)], { chapterNo: 5 })
  applyStateChanges(
    p,
    [{ kind: 'knowledge', characterId: gu, fact: '沈砚离开了档案馆', belief: 'knows', sinceChapter: 5 }],
    { chapterNo: 5 }
  )
  const s3 = currentSnapshot(p, { chapterNo: 3 })
  assert.equal(s3.states.length, 1)
  assert.equal(s3.states[0].value, '档案馆')
  assert.equal(s3.knowledge.length, 0)
  const s5 = currentSnapshot(p, { chapterNo: 5 })
  assert.equal(s5.states[0].value, '青江桥')
  assert.equal(s5.knowledge.length, 1)
})

/* ==================== 旧数据兼容 ==================== */

test('旧数据中同键多条 active 时，一并清理并保持可查', () => {
  const p = project()
  const shen = ids(p)['沈砚']
  ensureLedger(p)
  // 模拟 R2 之前遗留：同键两条 active（没有 untilChapter 概念）
  p.ledger.currentState.push(
    makeState({ subjectId: shen, attribute: P, value: '档案馆', sinceChapter: 1 }),
    makeState({ subjectId: shen, attribute: P, value: '青江桥', sinceChapter: 2 })
  )
  const res = applyStateChanges(p, [move(p, '沈砚', '荒宅', 3)], { chapterNo: 3 })
  assert.equal(res.ok, true)
  assert.equal(res.applied.superseded, 2, '两条遗留 active 都应被正确收尾')
  const active = p.ledger.currentState.filter((s) => s.status === 'active')
  assert.equal(active.length, 1)
  assert.equal(active[0].value, '荒宅')
  // fromValue 取章号最晚的既有值
  const ev = queryEventsAtChapter(p, 3)[0]
  assert.equal(ev.fromValue, '青江桥')
})

test('历史遗留的认知记录同样按 (角色, 内容) 归并', () => {
  const p = project()
  const gu = ids(p)['顾行舟']
  ensureLedger(p)
  p.ledger.characterKnowledge.push(makeKnowledge({ characterId: gu, fact: '某件事', belief: 'suspects', sinceChapter: 1 }))
  applyStateChanges(
    p,
    [{ kind: 'knowledge', characterId: gu, fact: '某件事', belief: 'knows', sinceChapter: 2 }],
    { chapterNo: 2 }
  )
  const hist = queryKnowledgeHistory(p, { characterId: gu, fact: '某件事' })
  assert.equal(hist.length, 2)
  assert.equal(hist[0].status, 'superseded')
  assert.equal(hist[1].status, 'active')
})
