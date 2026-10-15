import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWriterPacket, renderWriterPacket, findLeaks } from '../server/projection.js'
import { makeEntity, makeFact, makeThread, makeState, makeKnowledge, emptyLedger } from '../server/schema.js'

/* ===================== fixture：v2 结构的含秘密作品 =====================
   顾行舟的真实身份是第 26 章才揭示的，属于最高机密。
   ==================================================================== */

function makeProject() {
  const shen = makeEntity({
    name: '沈砚',
    publicRole: '文书修复员',
    publicIdentity: '32岁，市档案馆文书修复员，独居',
    authorRole: '主角',
  })
  const gu = makeEntity({
    name: '顾行舟',
    publicRole: '档案馆志愿者',
    publicIdentity: '26岁，修复手艺极好，两个月前来到档案馆',
    authorRole: '对手',
    secret: '实为十年前死者林晚之子，筹划此局十年',
  })

  return {
    id: 'p_test',
    title: '十年雨信',
    genre: '悬疑',
    idea: '主角在雨夜收到一封来自十年后的信',
    entities: [shen, gu],
    outline: {
      logline: '档案修复师雨夜收到来自十年后的信，被迫重查自己遗忘的一桩旧案。',
      theme: '遗忘不是赦免，而是共谋。',
      style: '第三人称限知，短句为主，冷硬克制，档案式白描。',
      cast: [
        { name: '沈砚', entityId: shen.id },
        { name: '顾行舟', entityId: gu.id },
      ],
      foreshadows: [
        {
          id: 'f1',
          seed: '信封上的邮戳来自一九九八年就已撤销的城南邮局',
          payoff: '信并非邮寄，而是有人亲手投入信箱，证明沈砚长期被监视',
          plantAt: 10,
          revealAt: 26,
        },
      ],
      volumes: [
        {
          title: '卷一',
          goal: '让预言应验',
          chapters: [
            {
              no: 1,
              title: '雨夜投递',
              summary: '沈砚在信箱里收到一封署名自己的信',
              goal: '他保留信封并抄下日期',
              cast: [shen.id],
              foreshadows: [],
            },
            {
              no: 3,
              title: '笔迹吻合度',
              summary: '沈砚比对信件与自己的笔迹',
              goal: '确认无法被普通仿写',
              cast: [shen.id, gu.id],
              foreshadows: [],
            },
            {
              no: 51,
              title: '旧疤的来处',
              summary: '沈砚重新翻出关于旧疤的记录',
              goal: '他决定去查那道疤',
              cast: [shen.id],
              foreshadows: [],
            },
            {
              no: 10,
              title: '城南邮局',
              summary: '他去鉴定邮戳，得知那家邮局早已撤销',
              goal: '确认信是亲手投递',
              cast: [shen.id, gu.id],
              foreshadows: [{ id: 'f1', action: 'plant' }],
            },
            {
              no: 26,
              title: '十年布局',
              summary: '顾行舟承认伪造未来信的全部手法',
              goal: '机制被解释',
              cast: [shen.id, gu.id],
              foreshadows: [{ id: 'f1', action: 'pay_off' }],
            },
          ],
        },
      ],
      totalChapters: 3,
    },
    chapters: [],
    ledger: emptyLedger(),
    _ids: { shen: shen.id, gu: gu.id },
  }
}

/* ===================== 确定性测试：信息边界 ===================== */

test('实体秘密不得出现在 WriterPacket 中（全字段扫描）', () => {
  for (const no of [1, 10]) {
    const p = makeProject()
    const packet = buildWriterPacket(p, no)
    assert.deepEqual(findLeaks(packet, p), [], `第 ${no} 章不应有泄漏`)
  }
})

test('秘密不得出现在渲染后的提示词中', () => {
  for (const no of [1, 10]) {
    const p = makeProject()
    const text = renderWriterPacket(buildWriterPacket(p, no))
    assert.equal(text.includes('林晚之子'), false)
    assert.equal(text.includes('筹划此局十年'), false)
  }
})

test('作者侧定位「对手」不得外泄，公开定位正常保留', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 10)
  const text = renderWriterPacket(packet)
  assert.equal(text.includes('（对手）'), false)
  const gu = packet.cast.find((c) => c.name === '顾行舟')
  assert.equal(gu.role, '档案馆志愿者')
  assert.equal(gu.identity.includes('林晚之子'), false)
})

test('出场白名单：第 1 章未列出顾行舟，则其不出现在上下文中', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 1)
  assert.equal(packet.cast.some((c) => c.name === '顾行舟'), false)
  assert.equal(renderWriterPacket(packet).includes('顾行舟'), false)
})

test('主角始终可见（否则正文无从下笔）', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 1)
  assert.equal(packet.cast.some((c) => c.name === '沈砚'), true)
})

test('伏笔只给表层线索 seed，不给真实含义 payoff', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 10)
  const text = renderWriterPacket(packet)
  assert.ok(text.includes('城南邮局'))
  assert.equal(text.includes('亲手投入信箱'), false)
  assert.equal(packet.task.foreshadows.length, 1)
})

test('上下文不得包含其他章节的概要', () => {
  const p = makeProject()
  const text = renderWriterPacket(buildWriterPacket(p, 1))
  assert.equal(text.includes('得知那家邮局早已撤销'), false)
  assert.equal(text.includes('承认伪造未来信'), false)
})

/* ===================== 账本投影 ===================== */

test('可逆状态（持有物 / 伤势）会进入正文上下文', () => {
  const p = makeProject()
  p.ledger.currentState.push(
    makeState({ subjectId: p._ids.shen, attribute: '持有', value: '一封署名自己的信', sinceChapter: 1 }),
    makeState({ subjectId: p._ids.shen, attribute: '伤势', value: '左手腕旧伤复发', sinceChapter: 2 })
  )
  const text = renderWriterPacket(buildWriterPacket(p, 3))
  assert.ok(text.includes('当前状态'))
  assert.ok(text.includes('一封署名自己的信'))
  assert.ok(text.includes('左手腕旧伤复发'))
})

test('角色认知只投影本章出场角色的', () => {
  const p = makeProject()
  p.ledger.characterKnowledge.push(
    makeKnowledge({ characterId: p._ids.shen, fact: '信上的落款是十年后' }),
    makeKnowledge({ characterId: p._ids.gu, fact: '母亲的案子细节' })
  )
  const text = renderWriterPacket(buildWriterPacket(p, 1))
  assert.ok(text.includes('信上的落款是十年后'))
  assert.equal(text.includes('母亲的案子细节'), false, '未出场角色的认知不应泄漏')
})

test('secret 可见性的账本条目不进入上下文', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '陈墨是沈砚的兄长', entityIds: [p._ids.shen], visibility: 'secret' }),
    makeFact({ text: '沈砚在档案馆工作', entityIds: [p._ids.shen], visibility: 'public' })
  )
  const text = renderWriterPacket(buildWriterPacket(p, 3))
  assert.equal(text.includes('陈墨是沈砚的兄长'), false)
  assert.ok(text.includes('沈砚在档案馆工作'))
})

test('长期未提及但与本章相关的早期线索仍会被投影', () => {
  const p = makeProject()
  p.ledger.canonicalFacts.push(
    makeFact({ text: '沈砚左手腕有一道不记得来源的旧疤', entityIds: [p._ids.shen], sourceChapter: 1 })
  )
  for (let i = 0; i < 120; i++) {
    p.ledger.canonicalFacts.push(makeFact({ text: `无关记录 ${i}`, sourceChapter: 50 }))
  }
  const text = renderWriterPacket(buildWriterPacket(p, 51))
  assert.ok(text.includes('不记得来源的旧疤'), '早期相关线索不能被「末 N 条」淘汰')
})

/* ===================== 断言自身的有效性 ===================== */

test('findLeaks 能抓到故意注入的秘密', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 1)
  packet.task.summary += '，并且顾行舟实为十年前死者林晚之子'
  const leaks = findLeaks(packet, p)
  assert.ok(leaks.some((l) => l.type === 'entity-secret' || l.type === 'entity-secret-full'))
})

test('findLeaks 能抓到故意注入的其他章节概要', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 1)
  packet.context.facts.push('他去鉴定邮戳，得知那家邮局早已撤销')
  assert.ok(findLeaks(packet, p).some((l) => l.type === 'other-chapter-summary'))
})

test('findLeaks 能抓到故意注入的伏笔真实含义', () => {
  const p = makeProject()
  const packet = buildWriterPacket(p, 1)
  packet.context.threads.push('信并非邮寄，而是有人亲手投入信箱')
  assert.ok(findLeaks(packet, p).some((l) => l.type === 'foreshadow-payoff'))
})

test('未使用的 makeThread 保持可导入（账本线索投影由 ledger 测试覆盖）', () => {
  assert.equal(typeof makeThread, 'function')
})

/* --------- 全量压测现场：上下文只给「未了结」，模型没完没了加新线索 --------- */
/**
 * 现场（v2.0.0 全量 30 章压测）：`plotThreads` 累计 82 条**全部 open**，`resolved` 只产出 1 条。
 * 原因是上下文里只有【尚未了结的线索】这一个清单 —— 模型看不到「哪些已经收尾」，
 * 于是把已了结的线当悬案反复展开、或换个说法重复引入同一件事。
 *
 * 修法：`contextBlock` 增加【已经了结的线索与伏笔】区块，每条带「（已完成）」前缀，
 * 并明确要求「不要再当疑点展开、也不要换说法重埋」。清单**限量**（默认各 8 条），
 * 否则它自己会变成新的膨胀源。只送 seed，**绝不送 payoff**（与 findLeaks 规则一致）。
 */
test('投影：已了结的线索以「（已完成）」进入上下文，单列一个区块', () => {
  const p = makeProject()
  // ⚠️ 2026-10-13：这条通道现在与 selectContext 共用同一判据（`ledger.isWriterVisible`），
  //    所以夹具里的 `sourceChapter` 必须在**本章（第 10 章）边界之内**——
  //    把「第 12/18 章才出现的线索」说成「已完成」送进第 10 章，本身就是提前泄底。
  p.ledger = { ...emptyLedger(),
    plotThreads: [
      makeThread({ text: '城南邮局的来历已查清', status: 'paid_off', sourceChapter: 6 }),
      makeThread({ text: '旧疤的记录已找到', status: 'paid_off', sourceChapter: 8 }),
      makeThread({ text: '这件事还悬着', status: 'open', sourceChapter: 5 }),
    ] }
  const packet = buildWriterPacket(p, 10)
  assert.deepEqual(packet.context.closedThreads, ['旧疤的记录已找到', '城南邮局的来历已查清'],
    '已了结的两条都要在，且按章号降序（最近的在前）')
  const text = renderWriterPacket(packet)
  assert.match(text, /【已经了结的线索与伏笔】/)
  assert.match(text, /· （已完成）旧疤的记录已找到/)
  assert.match(text, /不要再当作疑点重新展开/)
  // 未了结的那条仍走原来的区块，不该混进「已完成」
  assert.match(text, /【尚未了结的线索】/)
  assert.doesNotMatch(text, /（已完成）这件事还悬着/)
})

test('投影：已回收的伏笔进「已完成」清单，但只给 seed、绝不送 payoff', () => {
  const p = makeProject()
  p.outline.foreshadows[0].lifecycle = 'paid_off'
  const packet = buildWriterPacket(p, 10)
  assert.equal(packet.context.doneForeshadows.length, 1)
  const text = renderWriterPacket(packet)
  assert.match(text, /（已完成）f1：/)
  assert.ok(text.includes(String(p.outline.foreshadows[0].seed).slice(0, 12)), 'seed 应出现')
  assert.ok(!text.includes(String(p.outline.foreshadows[0].payoff).slice(0, 12)),
    'payoff（作者侧真相）绝不能进正文提示词')
})

test('投影：没有已了结内容时不出现空区块（不占预算）', () => {
  const p = makeProject()
  const text = renderWriterPacket(buildWriterPacket(p, 3))
  assert.doesNotMatch(text, /【已经了结的线索与伏笔】/)
})

test('投影：已完成清单限量，不会自己变成新的膨胀源', () => {
  const p = makeProject()
  p.ledger = { ...emptyLedger(),
    plotThreads: Array.from({ length: 30 }, (_, i) =>
      makeThread({ text: `已了结的线索 ${i}`, status: 'paid_off', sourceChapter: i + 1 })) }
  const packet = buildWriterPacket(p, 10)
  assert.equal(packet.context.closedThreads.length, 8, '默认最多 8 条')
  // ⚠️ 断言在 2026-10-13 被修正：这条通道以前**只看 status**，
  //    会把第 11~30 章才了结的线索也塞进第 10 章的提示词 —— 那本身就是**提前泄底**
  //    （等于告诉模型「后面这些线都会收掉」）。现在它和 selectContext 共用同一判据
  //    （`ledger.isWriterVisible`：secret / 不可信 / 时间边界之外一律不进）。
  //    所以第 10 章只能看到第 1~10 章里了结的线索，最近的一条是 9。
  assert.equal(packet.context.closedThreads[0], '已了结的线索 9', '保留最近的那几条（且不越过本章时间边界）')
})

test('投影：未来章才了结的线索不得进本章上下文（否则等于提前告诉模型结局）', () => {
  const p = makeProject()
  p.ledger = { ...emptyLedger(),
    plotThreads: [makeThread({ text: '第 20 章才收掉的线', status: 'paid_off', sourceChapter: 20 })] }
  assert.deepEqual(buildWriterPacket(p, 10).context.closedThreads, [])
})

test('投影：不可信 / secret 的「已了结线索」绝不进正文上下文（审计 P0 回归）', () => {
  const p = makeProject()
  p.ledger = { ...emptyLedger(), plotThreads: [
    // 模型推断、还没人工核实的线索：文字里很可能就写着真相，绝不能当「已完成」送出去
    makeThread({ text: '模型推断未核实的线', status: 'paid_off', sourceChapter: 3, trust: 'needsReview' }),
    // 作者侧的 secret 线索：同样不许进正文，哪怕它已经了结
    makeThread({ text: '作者侧秘密的线', status: 'paid_off', sourceChapter: 3, visibility: 'secret' }),
    makeThread({ text: '可信又公开的线', status: 'paid_off', sourceChapter: 3 }),
  ] }
  assert.deepEqual(buildWriterPacket(p, 10).context.closedThreads, ['可信又公开的线'])
})
