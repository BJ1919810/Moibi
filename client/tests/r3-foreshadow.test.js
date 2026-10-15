import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyLedger, makeEntity, makeThread, TRUST } from '../server/schema.js'
import { normalizeForeshadows, suggestLegacyLinks, importLinkProposals, revealDecision, recordForeshadowEvidence, makeLinkAssistantPacket } from '../server/foreshadow.js'
import { buildWriterPacket, findLeaks, renderWriterPacket } from '../server/projection.js'
import { recoverLiteralLegacyRecords, recoverReviewedProposals } from '../server/recovery.js'

function book() {
  const hero = makeEntity({ name: '沈砚', authorRole: '主角', publicRole: '主角' })
  const gu = makeEntity({ name: '顾行舟', authorRole: '对手', publicRole: '志愿者',
    secret: '顾行舟是林晚之子', revealProjections: [{ id: 'r1', safeText: '林晚正是顾行舟的母亲', approved: true }] })
  return {
    id: 'p_r3', title: '十年雨信', genre: '悬疑', entities: [hero, gu], chapters: [], ledger: emptyLedger(),
    outline: { title: '十年雨信', foreshadows: [
      { id: 'fs1', seed: '旧疤泛红', payoff: '顾行舟是林晚之子', plantChapter: 1, payoffChapter: 26,
        linkStatus: 'explicit', prerequisiteEventIds: [], safeReveal: { text: '手腕的旧疤来自当年桥上的冲突', approved: true } }],
      volumes: [{ title: '第一卷', chapters: [
        { no: 1, title: '第一章', cast: [hero.id], summary: '秘密作者内容', goal: '揭开身份',
          foreshadows: [{ id: 'fs1', action: 'plant' }] },
        { no: 2, title: '第二章', cast: [hero.id], foreshadows: [] },
        { no: 26, title: '第二十六章', cast: [hero.id, gu.id],
          writerSummary: '揭开旧疤的来源', writerGoal: '找到旧案关联', writerTaskApproval: 'author-approved',
          foreshadows: [{ id: 'fs1', action: 'pay_off', approved: true }],
          reveals: [{ entityId: gu.id, projectionId: 'r1', approved: true, prerequisiteEventIds: [] }] },
      ] }], totalChapters: 3 },
  }
}

test('R3: 计划了铺设但正文没有出现，不能生成实际伏笔事件', () => {
  const p = book()
  p.chapters.push({ no: 1, status: 'committed', text: '沈砚回家休息。' })
  const result = recordForeshadowEvidence(p, p.chapters[0], [{ foreshadowId: 'fs1', action: 'plant', evidence: '旧疤泛红' }])
  assert.equal(result.accepted.length, 0)
  assert.equal(p.ledger.foreshadowEvents.length, 0)
  assert.equal(p.outline.foreshadows[0].lifecycle, undefined)
})

test('R3: 提交过铺设证据且授权成功，回收才有 safeReveal 且原 payoff 不入正文', () => {
  const p = book()
  p.chapters.push({ no: 1, status: 'committed', text: '灯光下沈砚发现旧疤泛红，心里一沉。' })
  const a = recordForeshadowEvidence(p, p.chapters[0], [{ foreshadowId: 'fs1', action: 'plant', evidence: '旧疤泛红' }])
  assert.equal(a.accepted.length, 1)
  assert.equal(p.outline.foreshadows[0].lifecycle, 'planted')
  const packet = buildWriterPacket(p, 26)
  const rendered = renderWriterPacket(packet)
  assert.ok(rendered.includes('手腕的旧疤来自当年桥上的冲突'))
  assert.ok(rendered.includes('林晚正是顾行舟的母亲'))
  assert.ok(!rendered.includes('顾行舟是林晚之子'))
  assert.deepEqual(findLeaks(packet, p), [])
  const a2 = recordForeshadowEvidence(p, { no: 26, status: 'committed', text: '灯光下他终于知道：手腕的旧疤来自当年桥上的冲突。' },
    [{ foreshadowId: 'fs1', action: 'pay_off', evidence: '手腕的旧疤来自当年桥上的冲突' }])
  assert.equal(a2.accepted.length, 1)
  assert.equal(p.outline.foreshadows[0].lifecycle, 'paid_off')
})

test('R3: 第26章到了但前置铺设没有发生，必须阻断披露', () => {
  const p = book()
  assert.equal(revealDecision(p, p.outline.volumes[0].chapters[2], p.outline.foreshadows[0]).reason, 'not-planted')
  assert.throws(() => buildWriterPacket(p, 26), /未授权/)
})

test('R3: 前置事件额外缺失也必须阻断，即使存在实际铺设', () => {
  const p = book()
  p.ledger.foreshadowEvents.push({ id: 'fe1', foreshadowId: 'fs1', action: 'plant', chapterNo: 1, status: 'accepted', trust: TRUST.CANONICAL })
  p.outline.foreshadows[0].prerequisiteEventIds = ['missing-event']
  assert.equal(revealDecision(p, p.outline.volumes[0].chapters[2], p.outline.foreshadows[0]).reason, 'missing-prerequisite')
})

test('R3: 候选关联经模型建议仍 needsReview，不成为正文权限', () => {
  const p = book()
  p.outline.foreshadows[0].linkStatus = 'needsReview'
  const report = importLinkProposals(p, [{ foreshadowId: 'fs1', plantChapter: 1, payoffChapter: 26, evidence: '某模型推测', confidence: 0.8 }])
  assert.equal(report[0].status, 'needsReview')
  assert.throws(() => buildWriterPacket(p, 26), /未授权/)
  assert.equal(makeLinkAssistantPacket(p).chapters.length, 3)
  assert.ok(suggestLegacyLinks(p).length > 0)
})

test('R3: 审核链接不倒灌正文事实，也不伪造事件', () => {
  const p = book()
  p.outline.foreshadows[0].linkStatus = 'needsReview'
  const report = importLinkProposals(p, [{ foreshadowId: 'fs1', plantChapter: 1, payoffChapter: 26, evidence: '逐章核对大纲' }],
    { reviewed: true, reviewer: 'owner' })
  assert.equal(report[0].status, 'explicit')
  assert.equal(p.ledger.foreshadowEvents.length, 0)
  assert.equal(p.outline.volumes[0].chapters[2].foreshadows[0].approved, true)
})

test('R3: 旧记忆仅凭与正文逐字吻合可提升可信，其他继续隔离', () => {
  const p = book()
  p.chapters.push({ no: 1, status: 'committed', text: '沈砚收到没有邮戳的信封，并收进袋子。' })
  p.ledger.canonicalFacts.push({ id: 'f1', text: '沈砚收到没有邮戳的信封', trust: TRUST.LEGACY_UNVERIFIED, sourceChapter: null },
    { id: 'f2', text: '顾行舟偷偷修改了档案', trust: TRUST.LEGACY_UNVERIFIED, sourceChapter: null })
  const result = recoverLiteralLegacyRecords(p)
  assert.deepEqual(result.restored.facts, ['f1'])
  assert.deepEqual(result.pending.facts, ['f2'])
  assert.equal(p.ledger.canonicalFacts[0].sourceSpan.quote, '沈砚收到没有邮戳的信封')
  assert.equal(p.ledger.canonicalFacts[1].trust, TRUST.LEGACY_UNVERIFIED)
})

test('R3: 模型语义恢复请求必须有正文证据，未审核永不变正式', () => {
  const p = book()
  p.chapters.push({ no: 1, status: 'committed', text: '沈砚看到桌上的米白色信封，把它收了起来。' })
  const r = recoverReviewedProposals(p, [{ kind: 'fact', chapterNo: 1, text: '沈砚保留了一封信', evidence: '沈砚看到桌上的米白色信封，把它收了起来' }])
  assert.equal(r[0].status, 'needsReview')
  assert.equal(p.ledger.canonicalFacts[0].sourceChapter, 1)
  assert.equal(recoverReviewedProposals(p, [{ kind: 'fact', chapterNo: 2, text: '不曾出现', evidence: '从未出现过的证据' }])[0].ok, false)
})

test('R3: 上一章的待验证作者摘要不能作为本章正文任务透传', () => {
  const p = book()
  const packet = buildWriterPacket(p, 1)
  const prompt = renderWriterPacket(packet)
  assert.ok(!prompt.includes('秘密作者内容'))
  assert.ok(!prompt.includes('揭开身份'))
  assert.equal(packet.diagnostics.taskStatus, 'safe-fallback')
})

test('R3: 已正式披露的真相进入后续读者记忆，但不会变成角色认知', async () => {
  const { recordEntityRevealEvidence } = await import('../server/foreshadow.js')
  const p = book()
  p.chapters.push({ no: 1, status: 'committed', text: '灯光下沈砚发现旧疤泛红，心里一沉。' })
  recordForeshadowEvidence(p, p.chapters[0], [{ foreshadowId: 'fs1', action: 'plant', evidence: '旧疤泛红' }])
  const r = recordEntityRevealEvidence(p, {
    no: 26, status: 'committed', text: '顾行舟告诉他，林晚正是顾行舟的母亲。',
  }, [{ entityId: p.entities[1].id, projectionId: 'r1', evidence: '林晚正是顾行舟的母亲' }], { sourceVersion: 8 })
  assert.equal(r.accepted.length, 1)
  p.outline.volumes[0].chapters.push({ no: 27, cast: [p.entities[0].id], foreshadows: [] })
  const packet = buildWriterPacket(p, 27)
  assert.ok(renderWriterPacket(packet).includes('林晚正是顾行舟的母亲'))
  assert.equal(packet.context.knowledge.length, 0, '读者得知不等于主角知道')
  assert.deepEqual(findLeaks(packet, p), [])
})

test('R3: R3 结构修补重复执行不改变数据', async () => {
  const { migrateProject } = await import('../server/migrate.js')
  const p = book()
  delete p.outline.foreshadows[0].lifecycle
  delete p.ledger.foreshadowEvents
  p.schemaVersion = 2
  const first = migrateProject(p)
  const second = migrateProject(first.project)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
  assert.ok(Array.isArray(first.project.ledger.foreshadowEvents))
})

/* --------- 全量压测现场：伏笔清单从未喂给抽取模型 ⇒ 铺设事件永远是空的 --------- */
/**
 * 现场（v2.0.0 全量 30 章压测，1–17 章真实付费）：`ledger.foreshadowEvents` 共 **0 条**，
 * 且各章 `extracted.foreshadows` 与 `foreshadowReview.rejected` **同时为空** ——
 * 说明模型一条都没提，不是被拒。
 *
 * 根因：`extractMessages(text, chapterNo)` 要求 `foreshadowId` 填「大纲中既有伏笔 ID」，
 * 但**从来没有把伏笔清单交给模型**。模型不知道 f1~f5 存在，自然只能输出空数组。
 * 后果链：无铺设事件 ⇒ `revealDecision()` 永远 `not-planted` ⇒ `projectForeshadows()` 永远 deny
 * ⇒ `buildWriterPacket()` 在**任何**回收章抛错 ⇒ 带伏笔的书写到第一个回收章就永久卡死。
 */
test('R3: 抽取提示词必须携带伏笔清单与本章允许的动作（否则模型无从引用）', async () => {
  const { extractMessages } = await import('../server/prompts.js')
  const catalog = [{ id: 'f1', seed: '最后一页有一行钢笔字', plantChapter: 3, payoffChapter: 26 }]
  const ctx = { foreshadows: catalog, plannedActions: [{ id: 'f1', action: 'reinforce' }] }
  const text = extractMessages('正文。', 18, ctx)[1].content
  assert.match(text, /本作伏笔清单/, '必须列出清单标题')
  assert.match(text, /f1/, '必须给出真实的伏笔 ID')
  assert.match(text, /最后一页有一行钢笔字/, '必须给出 seed，模型才能判断正文里写没写到')
  assert.match(text, /f1 → reinforce/, '必须列出本章允许的动作')
  assert.match(text, /不要输出 pay_off/, '回收授权永远不由模型决定')
})

test('R3: pay_off 未授权时不列入允许动作，并明确要求输出空数组', async () => {
  const { extractMessages } = await import('../server/prompts.js')
  const text = extractMessages('正文。', 26,
    { foreshadows: [{ id: 'f1', seed: 'x' }], plannedActions: [] })[1].content
  assert.match(text, /本章没有计划任何伏笔动作/)
  assert.match(text, /必须输出空数组/)
  assert.doesNotMatch(text, /f1 → pay_off/, '未授权的回收绝不能被模型自行输出')
})

test('R3: 不传 ctx 时保持旧行为（不注入清单块，向后兼容）', async () => {
  const { extractMessages } = await import('../server/prompts.js')
  const text = extractMessages('正文。', 1)[1].content
  assert.doesNotMatch(text, /本作伏笔清单/)
  assert.match(text, /只记录正文中明确写出的内容|请阅读下面这一章正文/)
})

test('R3: 端到端 —— 有了清单，模型提出的铺设证据能真正入账并驱动态生命周期', () => {
  const p = book()
  const plan = p.outline.volumes[0].chapters[0]
  plan.foreshadows = [{ id: 'fs1', action: 'reinforce', approved: true }]
  const chapter = { no: 1, status: 'committed', text: '他抬起手腕，那道旧疤又泛红了。', summary: 'x' }
  const rep = recordForeshadowEvidence(p, chapter,
    [{ foreshadowId: 'fs1', action: 'reinforce', evidence: '那道旧疤又泛红了' }], { sourceVersion: 1, extractOk: true })
  assert.equal(rep.accepted.length, 1, '证据逐字命中 ⇒ 应入账')
  assert.equal(p.ledger.foreshadowEvents.length, 1)
  assert.equal(p.outline.foreshadows[0].lifecycle, 'reinforced', '生命周期由真实事件驱动')
})

/* --------- 全量压测现场：上下文只给「未了结」，模型于是没完没了地加新线索 --------- */
/**
 * 现场（v2.0.0 全量 30 章压测，1–25 章真实付费）：`plotThreads` 累计 **82 条，全部 open**；
 * 25 章里 `extracted.resolved` 只产出过 **1 条**。抽取提示词只问「本章**新埋下**的线索」，
 * 既不给已有清单、也不要求报"了结" ⇒ 线索只增不减；而上下文上限 20 条 + 排序按章号降序
 * ⇒ 第 1~19 章埋的线索**全被挤出上下文**，模型再也看不见 ⇒「前后矛盾」。
 *
 * 修法（两处）：
 *   ① `extractMessages(text,no,{existingThreads,closedThreads})` —— 把两个清单喂给模型，
 *      并强制「了结的必须原文照抄进 resolved」；
 *   ② `projection.contextBlock` —— 新增【已经了结的线索与伏笔】区块，
 *      每条带「（已完成）」前缀，明确告诉模型「不要再当疑点展开、也不要换说法重埋」。
 */
test('R3: 抽取提示词必须携带已有线索清单，并强制要求报「了结」', async () => {
  const { extractMessages } = await import('../server/prompts.js')
  const text = extractMessages('正文。', 5, {
    existingThreads: ['旧部志最后一页有钢笔字', '门锁从未换过'],
    closedThreads: ['周小满找回伞'],
  })[1].content
  assert.match(text, /本作已有线索清单/)
  assert.match(text, /尚未了结/)
  assert.match(text, /旧部志最后一页有钢笔字/)
  assert.match(text, /已经了结/)
  assert.match(text, /周小满找回伞/)
  assert.match(text, /一律不要输出/, '必须明确禁止重复输出已有线索')
  assert.match(text, /必须.*原文照抄.*resolved|必须.*resolved/s, '必须强制要求报了结')
})

test('R3: 不传线索 ctx 时保持旧行为（不注入清单块，向后兼容）', async () => {
  const { extractMessages } = await import('../server/prompts.js')
  const text = extractMessages('正文。', 1)[1].content
  assert.doesNotMatch(text, /本作已有线索清单/)
  assert.doesNotMatch(text, /undefined/)
})

test('R3: 空清单不占位（避免每章都塞一段无意义的「（无）」）', async () => {
  const { extractMessages } = await import('../server/prompts.js')
  const text = extractMessages('正文。', 1, { existingThreads: [], closedThreads: [] })[1].content
  assert.doesNotMatch(text, /本作已有线索清单/)
})
