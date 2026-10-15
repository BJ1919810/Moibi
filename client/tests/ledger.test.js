import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureLedger,
  addFacts,
  addStates,
  addKnowledge,
  addThreads,
  resolveThreads,
  selectContext,
  queryFacts,
  queryStateHistory,
  applyExtraction,
  makeNameResolver,
  applyLearnedAliases,
  matchNames,
} from '../server/ledger.js'
import { makeEntity, makeFact, makeState, makeThread, makeKnowledge, emptyLedger } from '../server/schema.js'

/* ========================= fixture ========================= */

function project() {
  const shen = makeEntity({ name: '沈砚' })
  const gu = makeEntity({ name: '顾行舟' })
  return {
    id: 'p1',
    entities: [shen, gu],
    ledger: emptyLedger(),
    outline: { volumes: [] },
    chapters: [],
  }
}

/* ==================== 存储层：永不截断 ==================== */

test('存储层不因条数截断：写入 200 条后仍保留 200 条', () => {
  const p = project()
  const entries = Array.from({ length: 200 }, (_, i) => makeFact({ text: `第 ${i} 条事实`, sourceChapter: 50 }))
  addFacts(p, entries)
  assert.equal(p.ledger.canonicalFacts.length, 200)
})

test('重复写入同一内容不会产生重复记录（按内容 ID 去重）', () => {
  const p = project()
  addFacts(p, [makeFact({ text: '铜钥匙归沈砚所有' })])
  addFacts(p, [makeFact({ text: '铜钥匙归沈砚所有。' })]) // 句末标点不同，ID 相同
  assert.equal(p.ledger.canonicalFacts.length, 1)
})

/* ==================== 上下文层：相关性优先 ==================== */

test('早期但与本章相关的线索不会被「末 N 条」淘汰', () => {
  const p = project()
  const shenId = p.entities.find((e) => e.name === '沈砚').id

  // 第 1 章埋下、与沈砚相关
  addFacts(p, [
    makeFact({ text: '沈砚左手腕有一道旧疤', entityIds: [shenId], sourceChapter: 1 }),
  ])
  // 之后堆积 200 条无关事实，且出处都更靠后
  addFacts(
    p,
    Array.from({ length: 200 }, (_, i) => makeFact({ text: `无关事实 ${i}`, sourceChapter: 60 }))
  )

  const ctx = selectContext(p, { chapterNo: 61, entityIds: [shenId], budget: { maxFacts: 5 } })
  assert.ok(
    ctx.facts.some((f) => f.text.includes('旧疤')),
    '第 1 章的相关线索必须仍在上下文里'
  )
})

test('不相关的事实按出处就近补足，且受预算上限约束', () => {
  const p = project()
  addFacts(
    p,
    Array.from({ length: 50 }, (_, i) => makeFact({ text: `事实 ${i}`, sourceChapter: i + 1 }))
  )
  const ctx = selectContext(p, { chapterNo: 50, entityIds: [], budget: { maxFacts: 10 } })
  assert.equal(ctx.facts.length, 10)
  // 就近优先：应包含出处最大的几条
  assert.ok(ctx.facts.some((f) => f.sourceChapter === 50))
})

test('secret 可见性的条目不进入上下文', () => {
  const p = project()
  const shenId = p.entities[0].id
  addFacts(p, [
    makeFact({ text: '陈墨是沈砚的兄长', entityIds: [shenId], visibility: 'secret' }),
    makeFact({ text: '沈砚在档案馆工作', entityIds: [shenId], visibility: 'public' }),
  ])
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [shenId] })
  assert.equal(ctx.facts.length, 1)
  assert.equal(ctx.facts[0].text, '沈砚在档案馆工作')
})

test('角色认知只取本章出场角色的', () => {
  const p = project()
  const [shen, gu] = p.entities
  addKnowledge(p, [
    makeKnowledge({ characterId: shen.id, fact: '417 号卷宗存在' }),
    makeKnowledge({ characterId: gu.id, fact: '林晚之死真相' }),
  ])
  const ctx = selectContext(p, { chapterNo: 3, entityIds: [shen.id] })
  assert.equal(ctx.knowledge.length, 1)
  assert.equal(ctx.knowledge[0].characterId, shen.id)
})

test('本章涉及的伏笔优先于其他未了结线索', () => {
  const p = project()
  addThreads(p, [
    makeThread({ text: '邮戳来自城南邮局', foreshadowId: 'f1' }),
    makeThread({ text: '某条无关线索', foreshadowId: 'f9' }),
  ])
  const ctx = selectContext(p, { chapterNo: 10, foreshadowIds: ['f1'] })
  assert.equal(ctx.threads[0].foreshadowId, 'f1')
})

/* ==================== 状态与历史查询 ==================== */

test('已了结的线索只改状态，不删除', () => {
  const p = project()
  addThreads(p, [makeThread({ text: '邮戳的来源' })])
  resolveThreads(p, ['邮戳的来源'])
  assert.equal(p.ledger.plotThreads.length, 1, '记录必须保留，供日后回查')
  assert.equal(p.ledger.plotThreads[0].status, 'paid_off')
  assert.ok(p.ledger.plotThreads[0].paidOffAt)
})

test('可逆状态（伤势 / 持有物）能记录且可查询变更轨迹', () => {
  const p = project()
  const shenId = p.entities[0].id
  addStates(p, [
    makeState({ subjectId: shenId, attribute: '伤势', value: '左臂骨折', sinceChapter: 5 }),
    makeState({ subjectId: shenId, attribute: '持有', value: '铜钥匙', sinceChapter: 6 }),
  ])
  const hist = queryStateHistory(p, shenId)
  assert.equal(hist.length, 2)
  const ctx = selectContext(p, { chapterNo: 6, entityIds: [shenId] })
  assert.ok(ctx.states.some((s) => s.attribute === '伤势' && s.value === '左臂骨折'))
})

test('历史查询：按实体与章号回看当时已知的事实', () => {
  const p = project()
  const shenId = p.entities[0].id
  addFacts(p, [
    makeFact({ text: '沈砚在档案馆工作', entityIds: [shenId], sourceChapter: 1 }),
    makeFact({ text: '沈砚拿到了铜钥匙', entityIds: [shenId], sourceChapter: 6 }),
  ])
  const atThree = queryFacts(p, { entityId: shenId, uptoChapter: 3 })
  assert.equal(atThree.length, 1)
  assert.equal(atThree[0].text, '沈砚在档案馆工作')

  const all = queryFacts(p, { entityId: shenId })
  assert.equal(all.length, 2)
})

/* ==================== 改名不失效 ==================== */

test('数据层改名后，ID 与既有事实关联都不失效', () => {
  const p = project()
  const gu = p.entities.find((e) => e.name === '顾行舟')
  const idBefore = gu.id
  const guId = gu.id
  addFacts(p, [makeFact({ text: '顾行舟来到档案馆', entityIds: [guId], sourceChapter: 1 })])

  // 改名：只动 name，把旧名收进 aliases
  gu.name = '顾川'
  gu.aliases = ['顾行舟']

  assert.equal(gu.id, idBefore, '实体 ID 不随名字变化')
  const facts = queryFacts(p, { entityId: idBefore })
  assert.equal(facts.length, 1, '按 ID 关联的事实仍然查得到')

  // 别名可用：新提取的文本中出现旧名，仍能解析回同一实体
  const resolve = makeNameResolver(p)
  assert.equal(resolve('顾行舟'), idBefore)
  assert.equal(resolve('顾川'), idBefore)
})

test('matchNames 同时认名字与别名', () => {
  const p = project()
  const gu = p.entities.find((e) => e.name === '顾行舟')
  gu.name = '顾川'
  gu.aliases = ['顾行舟']
  const hits = matchNames('顾行舟把信投进了信箱', p)
  assert.deepEqual(hits, [gu.id])
})

/* ==================== 提取结果落账 ==================== */

test('applyExtraction 把四类结果落进账本并建立实体关联', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  const shenId = resolve('沈砚')

  applyExtraction(
    p,
    {
      summary: '收到信',
      facts: ['沈砚收到一封署名自己的信'],
      states: [{ subject: '沈砚', attribute: '持有', value: '一封署名自己的信' }],
      knowledge: [{ character: '沈砚', fact: '信上写着自己十年后的落款', belief: 'knows' }],
      threads: ['信封上的邮戳来自城南邮局'],
      resolved: [],
    },
    { chapterNo: 1, resolveName: resolve }
  )

  assert.equal(p.ledger.canonicalFacts.length, 1)
  assert.equal(p.ledger.canonicalFacts[0].sourceChapter, 1, '必须记录出处章号')
  assert.deepEqual(p.ledger.canonicalFacts[0].entityIds, [shenId])
  assert.equal(p.ledger.currentState.length, 1)
  assert.equal(p.ledger.characterKnowledge.length, 1)
  assert.equal(p.ledger.plotThreads.length, 1)
})

test('applyExtraction 能标记旧线索已了结', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  applyExtraction(p, { threads: ['邮戳的来源'] }, { chapterNo: 1, resolveName: resolve })
  applyExtraction(p, { resolved: ['邮戳的来源'] }, { chapterNo: 10, resolveName: resolve })
  assert.equal(p.ledger.plotThreads.length, 1)
  assert.equal(p.ledger.plotThreads[0].status, 'paid_off')
})

test('ensureLedger 能为缺失账本的旧项目补齐结构', () => {
  const p = { id: 'x' }
  const l = ensureLedger(p)
  assert.deepEqual(Object.keys(l).sort(), [
    'canonicalFacts',
    'characterKnowledge',
    'currentState',
    'foreshadowEvents',
    'plotThreads',
    'stateEvents',
  ])
})

/* ==================== R2-c：提取入口接入状态引擎 ==================== */

test('applyExtraction 走状态引擎：新状态生效时旧状态被收尾，并留下事件', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  const move = (ch, value, batchKey) =>
    applyExtraction(p, { states: [{ subject: '沈砚', attribute: '所在', value }] }, {
      chapterNo: ch,
      resolveName: resolve,
      batchKey,
    })

  move(1, '档案馆', 'b1')
  move(2, '青江桥', 'b2')

  assert.equal(p.ledger.currentState.length, 2, '两条记录都要留在存储层')
  const [first, second] = p.ledger.currentState
  assert.equal(first.status, 'superseded')
  assert.equal(first.untilChapter, 2, '被替代的章号就是新状态生效的章号')
  assert.equal(first.supersededBy, second.id)
  assert.equal(second.status, 'active')
  assert.equal(p.ledger.stateEvents.length, 2, '每次转移都要留下事件')
  assert.equal(p.ledger.stateEvents[1].fromValue, '档案馆')
  assert.equal(p.ledger.stateEvents[1].toValue, '青江桥')
})

test('【必测】同章往返经提取入口同样成立：档案馆 → 青江桥 → 档案馆', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  const ch = 3
  const values = ['档案馆', '青江桥', '档案馆']
  values.forEach((v, i) => {
    applyExtraction(p, { states: [{ subject: '沈砚', attribute: '所在', value: v }] }, {
      chapterNo: ch,
      resolveName: resolve,
      batchKey: `b${i}`,
    })
  })

  // 三次变化 = 三条记录、三个事件，各自可区分
  assert.equal(p.ledger.currentState.length, 3)
  assert.equal(p.ledger.stateEvents.length, 3)
  assert.equal(new Set(p.ledger.currentState.map((s) => s.id)).size, 3, '同内容往返必须是两条不同记录')
  assert.equal(new Set(p.ledger.stateEvents.map((e) => e.id)).size, 3)
  // 只有最后一次「档案馆」有效
  assert.equal(p.ledger.currentState[2].status, 'active')
  assert.equal(p.ledger.currentState[2].value, '档案馆')
  assert.equal(p.ledger.currentState[0].status, 'superseded')
  assert.equal(p.ledger.currentState[1].status, 'superseded')
})

test('【必测】applyExtraction 失败保护：非法转移使整批抽取不落账，账本一字未改', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  applyExtraction(
    p,
    { states: [{ subject: '沈砚', attribute: '所在', value: '青江桥' }] },
    { chapterNo: 5, resolveName: resolve, batchKey: 'b5' }
  )
  const before = JSON.stringify(p.ledger)

  const res = applyExtraction(
    p,
    {
      facts: ['顾行舟烧了那封信'],
      states: [{ subject: '沈砚', attribute: '所在', value: '档案馆' }],
      knowledge: [{ character: '沈砚', fact: '信是伪造的', belief: 'knows' }],
      threads: ['灰烬里剩下半片印章'],
    },
    { chapterNo: 3, resolveName: resolve, batchKey: 'b3' } // 时间倒退 → error
  )

  assert.equal(res.rejected, true)
  assert.ok(res.violations.some((v) => v.code === 'time-regression'))
  assert.equal(res.states, 0)
  assert.equal(res.knowledge, 0)
  assert.equal(res.facts, 0, '事实也必须一并放弃 —— 否则账本会留下半成品')
  assert.equal(res.threads, 0)
  assert.equal(JSON.stringify(p.ledger), before, '账本必须与本批抽取之前逐字一致')
})

test('warning 级问题只跳过该条，不拖垮整章抽取', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  const res = applyExtraction(
    p,
    {
      facts: ['江面上起了雾'],
      states: [
        { subject: '沈砚', attribute: '所在', value: '青江桥' },
        { subject: '周砚', attribute: '所在', value: '档案馆' }, // 实体不存在 → warning
      ],
    },
    { chapterNo: 2, resolveName: resolve, batchKey: 'w2' }
  )

  assert.equal(res.rejected, false)
  assert.equal(res.facts, 1, '一条坏状态不该让整章的记忆全部作废')
  assert.equal(res.states, 1)
  assert.ok(res.violations.some((v) => v.code === 'unknown-subject' && v.severity === 'warning'))
})

test('【必测】重复提交：同一提交标识连续执行两次，状态与事件都不翻倍', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  const payload = {
    facts: ['沈砚收到信'],
    states: [{ subject: '沈砚', attribute: '所在', value: '青江桥' }],
    knowledge: [{ character: '沈砚', fact: '信是十年前寄出的', belief: 'knows' }],
  }
  const ctx = { chapterNo: 2, resolveName: resolve, batchKey: 'same-batch' }

  const first = applyExtraction(p, payload, ctx)
  const second = applyExtraction(p, payload, ctx)

  assert.equal(first.states, 1)
  assert.equal(second.states, 0)
  assert.equal(second.knowledge, 0)
  assert.equal(second.transitionSkipped, true)
  assert.equal(p.ledger.currentState.length, 1)
  assert.equal(p.ledger.characterKnowledge.length, 1)
  assert.equal(p.ledger.stateEvents.length, 2, '一条状态事件 + 一条认知事件，第二次不再产生')
  assert.equal(second.events, 0)
  assert.equal(p.ledger.canonicalFacts.length, 1, '事实按内容 ID 去重，重提也不会翻倍')
})

test('被替代的旧认知不再进入上下文（避免同时看到「他怀疑」和「他确信」）', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  const shenId = resolve('沈砚')
  const say = (belief, ch) =>
    applyExtraction(
      p,
      { knowledge: [{ character: '沈砚', fact: '417 号卷宗存在', belief }] },
      { chapterNo: ch, resolveName: resolve, batchKey: `k${ch}` }
    )

  say('suspects', 3)
  say('knows', 5)

  assert.equal(p.ledger.characterKnowledge.length, 2, '演变历史必须留档')
  const ctx = selectContext(p, { chapterNo: 6, entityIds: [shenId] })
  assert.equal(ctx.knowledge.length, 1, '上下文里只能有一个当前认知')
  assert.equal(ctx.knowledge[0].belief, 'knows')
})

test('applyExtraction 给状态事件带上来源章号与正文版本', () => {
  const p = project()
  const resolve = makeNameResolver(p)
  applyExtraction(
    p,
    { states: [{ subject: '沈砚', attribute: '所在', value: '青江桥' }] },
    { chapterNo: 7, resolveName: resolve, sourceVersion: 8, batchKey: 'ch7:abc' }
  )
  const ev = p.ledger.stateEvents[0]
  assert.equal(ev.sourceChapter, 7)
  assert.equal(ev.sourceVersion, 8)
  assert.equal(ev.batchKey, 'ch7:abc')
  const rec = p.ledger.currentState[0]
  assert.equal(rec.sourceVersion, 8)
  assert.equal(rec.eventId, ev.id)
})

/* ================= 称呼漂移：主体名解析（真实踩过的坑） ================= */
//
// 模型抽出来的主体名是正文里的**称呼**，不是设定里的全名：
// 第 1 章正文写「遥学姐」，抽取结果就写「遥学姐」；写「会长」就写「会长」。
// 旧实现只认全名，于是整批抽取被判「状态变化的主体无法解析到实体」而拒稿 ——
// 用户看到的是「正文写完了却永远提交不进去」。

test('称呼漂移：日式全名的后缀简称能解析到实体（星野遥→遥、五十岚咲→咲）', () => {
  const p = {
    id: 'p_alias', entities: [makeEntity({ name: '星野遥' }), makeEntity({ name: '五十岚咲' })],
    ledger: emptyLedger(), outline: { volumes: [] }, chapters: [],
  }
  const body = '遥学姐坐在窗台边。咲把衬衫换了。岚咲两个字出现在纸上。'
  const resolve = makeNameResolver(p, { text: body })
  assert.equal(resolve('星野遥'), p.entities[0].id)
  assert.equal(resolve('遥'), p.entities[0].id, '三字名的末字称呼')
  assert.equal(resolve('咲'), p.entities[1].id, '四字名的末字称呼')
  assert.equal(resolve('岚咲'), p.entities[1].id, '四字名的末两字称呼')
  // 形状像但本章没出现过的写法不认（严格性来自「正文里真实出现过」这道闸）
  assert.equal(resolve('野遥'), null)
})

test('称呼漂移：剥掉敬称/关系后缀后再解析（遥学姐→遥）', () => {
  const p = {
    id: 'p_alias2', entities: [makeEntity({ name: '星野遥' }), makeEntity({ name: '五十岚咲' })],
    ledger: emptyLedger(), outline: { volumes: [] }, chapters: [],
  }
  const resolve = makeNameResolver(p, { text: '遥学姐在翻旧纸页。咲学姐也在。' })
  assert.equal(resolve('遥学姐'), p.entities[0].id)
  assert.equal(resolve('咲学姐'), p.entities[1].id)
  assert.equal(resolve('星野同学'), null, '「星野」不是已登记的称呼，不猜')
})

test('称呼漂移：解析成功后把简称记成别名，下次直接命中', () => {
  const p = {
    id: 'p_alias3', entities: [makeEntity({ name: '星野遥' })],
    ledger: emptyLedger(), outline: { volumes: [] }, chapters: [],
  }
  const resolved = makeNameResolver(p, { text: '遥学姐在翻旧纸页。' })
  assert.equal(resolved('遥'), p.entities[0].id)
  // ⚠️ 解析器**不得原地改 project**（拒绝提交的路径也必须一字未改），
  //    学到的称呼通过 learned 交回，由调用方在副本上落盘。
  assert.deepEqual(p.entities[0].aliases, [], '解析阶段不能碰正式对象')
  assert.deepEqual(resolved.learned, [{ name: '遥', id: p.entities[0].id }])
  const copy = structuredClone(p)
  assert.equal(applyLearnedAliases(copy, resolved.learned), true)
  assert.deepEqual(copy.entities[0].aliases, ['遥'], '学到的简称要落盘，别每次重推')
  // 第二次不再需要正文也能解析
  assert.equal(makeNameResolver(copy)('遥'), copy.entities[0].id)
  // 重复学习不产生重复别名
  assert.equal(applyLearnedAliases(copy, resolved.learned), false)
})

test('称呼漂移：正文里没出现过的简称不认，避免常用字误绑', () => {
  const p = {
    id: 'p_alias4', entities: [makeEntity({ name: '星野遥' }), makeEntity({ name: '神代凛' })],
    ledger: emptyLedger(), outline: { volumes: [] }, chapters: [],
  }
  // 本章只写到「凛」：同一个正文里没出现的「遥」不该被绑定，哪怕它形状也像简称。
  const resolve = makeNameResolver(p, { text: '凛站在走廊尽头。' })
  assert.equal(resolve('凛'), p.entities[1].id)
  assert.equal(resolve('代凛'), null, '末两字必须在正文里真实出现过')
  assert.deepEqual(p.entities[0].aliases, [], '没出现在正文里的简称不该被学习')
})

test('主体解析不到实体时只跳过该条，不阻断本章其余变化入账', () => {
  const p = {
    id: 'p_alias5', entities: [makeEntity({ name: '星野遥' })],
    ledger: emptyLedger(), outline: { volumes: [] }, chapters: [],
  }
  const body = '遥学姐锁上了柜子。'
  const counts = applyExtraction(p, { states: [
    { subject: '遥学姐', attribute: '位置', value: '窗台边', evidence: '遥学姐锁上了柜子。' },
    { subject: '部室柜子', attribute: '状态', value: '被锁上', evidence: '锁上了柜子。' },
  ] }, { chapterNo: 2, resolveName: makeNameResolver(p, { text: body }), batchKey: 'b-alias' })
  assert.equal(counts.rejected, false, '不能因为一个解析不到的主体就整批拒绝')
  assert.equal(counts.states, 1, '能解析的那条照常入账')
  assert.ok(counts.violations.some((v) => String(v.message).includes('部室柜子')))
})
