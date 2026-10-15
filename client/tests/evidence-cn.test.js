/**
 * BUG③ 回归：中文短证据（对白型）不应被「≥4 字符」的英文思维门槛误杀。
 *
 * 现场：第 1 章正文「“不是。”遥说。」真实存在，抽取给出 evidence = "不是。"（3 字符），
 * 却被旧门禁 `evidence.trim().length < 4` 提前判死，整章拒绝提交（all-or-nothing）。
 *
 * 新判据：**去标点后 ≥2 个实义字** 且 **必须在正文中原文精确定位**（includes）。
 * 这两个测试同时锁死「不误杀真证据」与「不放行假证据」两侧。
 * 全部为纯函数/内存夹具，不消费实际 API token。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, emptyLedger, makeFact, TRUST } from '../server/schema.js'
import { commitDraft } from '../server/workflow.js'
import { applyExtraction, makeNameResolver, evidenceCore, isSpecificEvidence, locateEvidence } from '../server/ledger.js'

const DIALOG = '“不是。”林舟说。'

function story() {
  const hero = makeEntity({ name: '林舟', authorRole: '主角', publicRole: '主角', publicIdentity: '修复师' })
  const keyFact = makeFact({ text: '林舟持有铜钥匙', entityIds: [hero.id], sourceChapter: 1 })
  return { id: 'p_cn_evidence', title: '测试小说', genre: '悬疑', idea: '失落的档案', headVersion: 1,
    entities: [hero], chapters: [{ no: 1, status: 'committed', text: '林舟把铜钥匙收进衣袋。', summary: '林舟取得铜钥匙。' }],
    ledger: { ...emptyLedger(), canonicalFacts: [keyFact] },
    outline: { title: '测试小说', logline: '寻找真相', style: '短句', foreshadows: [],
      volumes: [{ title: '第一卷', chapters: [{ no: 1, cast: [hero.id] },
      { no: 2, title: '查找', cast: [hero.id], writerTaskApproval: 'author-approved', writerSummary: '林舟检查旧档案', writerGoal: '发现遗失页', requiredFactIds: [keyFact.id], foreshadows: [] }] }], totalChapters: 2 } }
}

const draftWith = (extracted, text = DIALOG) => ({ no: 2, title: '查找', text, extractOk: true, extracted })

test('BUG③：3 个字符的中文对白证据可在正文精确定位时，正常提交', () => {
  const p = story()
  const before = JSON.stringify(p)
  const draft = draftWith({ summary: '林舟否认签字', facts: [], states: [],
    knowledge: [{ character: '林舟', fact: '旧部志上名字不是自己写的', belief: 'knows', evidence: '不是。' }],
    threads: [], resolved: [] })
  const r = commitDraft(p, draft, 1)
  assert.equal(r.project.headVersion, 2)
  assert.equal(r.project.chapters.find((c) => c.no === 2).status, 'committed')
  assert.equal(JSON.stringify(p), before, '纯函数不得原地修改传入的正式对象')
})

test('BUG③：同样的短证据，若正文里根本没有 ⇒ 该条不入账，但**不废整章**（正文已付费）', () => {
  const p = story()
  const draft = draftWith({ summary: '伪造', facts: [], states: [],
    knowledge: [{ character: '林舟', fact: '凭空捏造', belief: 'knows', evidence: '不是吧。' }], threads: [], resolved: [] })
  // 语义（v2.0.0 全量压测后收紧）：证据无法核实 ⇒ 只丢这一条，本章照常提交。
  // 判据与 state-engine 的 VIOLATION 分级一致 —— 这条坏数据**只影响它自己**，不污染别处。
  const r = commitDraft(p, draft, 1)
  assert.equal(r.chapter.status, 'committed', '整章不应因一条证据被废掉（已付费）')
  assert.equal((r.project.ledger.characterKnowledge || []).some((k) => k.fact === '凭空捏造'), false,
    '未核实的变化绝不允许进账本 —— 安全性由「不入账」保证')
  assert.ok(r.unresolvedSubjects.some((x) => /证据无法核实/.test(x) && /不是吧。/.test(x)),
    '必须如实告知作者有变化没入账')
})

test('BUG③：只有标点或单字的「证据」⇒ 该条不入账，本章仍提交（不是放宽到无门槛）', () => {
  const p = story('“嗯。”林舟说。')
  for (const bad of ['。', '，', '嗯']) {
    const draft = draftWith({ summary: '过短', facts: [], states: [],
      knowledge: [{ character: '林舟', fact: `x-${bad}`, belief: 'knows', evidence: bad }], threads: [], resolved: [] }, '“嗯。”林舟说。')
    const r = commitDraft(p, draft, 1)
    assert.equal((r.project.ledger.characterKnowledge || []).some((k) => k.fact === `x-${bad}`), false,
      `evidence=${bad} 过短 ⇒ 不得入账`)
    assert.ok(r.unresolvedSubjects.some((x) => /证据无法核实/.test(x)), `evidence=${bad} 应留下未入账记录`)
  }
})

test('BUG③：缺证据字段 ⇒ 该条不入账并如实记录（不废整章）', () => {
  const p = story()
  const draft = draftWith({ summary: '无证据', facts: [], states: [],
    knowledge: [{ character: '林舟', fact: '关键认知', belief: 'knows' }], threads: [], resolved: [] })
  const r = commitDraft(p, draft, 1)
  assert.equal(r.chapter.status, 'committed')
  assert.equal((r.project.ledger.characterKnowledge || []).some((k) => k.fact === '关键认知'), false)
  assert.ok(r.unresolvedSubjects.some((x) => /knowledge#0/.test(x) && /未给出证据/.test(x)),
    '未入账记录应指明是哪一条、原因是什么')
})

test('BUG③：账本对中文短证据的 fact/thread 同样按原文定位视为可定位', () => {
  const p = story()
  applyExtraction(p, {
    facts: [{ text: '林舟否认签字', evidence: '不是。' }], states: [], knowledge: [],
    threads: [{ text: '来源可疑', evidence: '不是。' }], resolved: [],
  }, { chapterNo: 3, resolveName: makeNameResolver(p), sourceVersion: 2, batchKey: 'b1', evidenceText: DIALOG })
  const fact = p.ledger.canonicalFacts.find((f) => f.text === '林舟否认签字')
  assert.equal(fact.trust, TRUST.CANONICAL)
  assert.equal(fact.sourceSpan.quote, '不是。')
  const thread = p.ledger.plotThreads.find((t) => t.text === '来源可疑')
  assert.equal(thread.sourceSpan.quote, '不是。')
})

test('BUG③：判据本身 —— 去标点后 ≥2 个实义字才算够具体', () => {
  assert.equal(evidenceCore('不是。'), '不是')
  assert.equal(isSpecificEvidence('不是。'), true)
  assert.equal(isSpecificEvidence('“不是。”'), true)
  assert.equal(isSpecificEvidence('嗯。'), false)
  assert.equal(isSpecificEvidence('。'), false)
  assert.equal(isSpecificEvidence(''), false)
  assert.equal(isSpecificEvidence('Go!'), true, '英文短词仍应通过')
})

/* --------- 全量压测第 1 章现场：模型给证据时自套引号 ⇒ 整章拒稿 --------- */
/**
 * 现场（v2.0.0 全量压测，真实付费）：第 1 章 2584 字已生成，提交门禁却报
 *   `关键状态或认知变化缺少正文证据，拒绝提交（states#0 沈砚 · 林晚给的新牛皮纸本：
 *    证据未在本章正文中原样出现；evidence=““从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。””）`
 *
 * 根因：模型把 evidence 写成**带引号的引文**（`“从书架上抽出……”`），
 * 而正文里那句是叙述句、**本身不带引号**。内容一字不差，只是多了层引用外壳。
 * 实测该章 10 条证据里 7 条栽在这上面（去引号后 100% 命中）。
 *
 * 修法：`locateEvidence(text, evidence)` —— 先原样找，找不到再剥掉**最外层成对引号/括号**，
 * 仍是 `indexOf` 逐字定位（不做模糊匹配、不归一化内部字符）⇒ 编造/改写的引文依旧过不了。
 */
test('地点：证据被模型套了外层引号，仍应在正文中逐字定位到（否则已付费正文取不出来）', () => {
  const body = '她转过身，从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。\n\n“明天放学后，部室见。”'
  const quoted = '“从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。”'
  // 修复前：body.includes(quoted) === false ⇒ 整章拒稿
  assert.equal(body.includes(quoted), false, '原样匹配确实失败（这就是当时的 bug）')
  const hit = locateEvidence(body, quoted)
  assert.ok(hit, '剥掉外层引号后必须命中')
  assert.equal(hit.quote, '从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。',
    '返回的 quote 必须是**正文里的实际片段**，不能带着模型加的引号')
  // 直角引号 / 书名号包裹同样要能命中
  assert.ok(locateEvidence(body, '「从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。」'))
})

test('地点：原样就在正文里的证据仍走「零改动」路径（不剥引号）', () => {
  const body = '“不是。”林舟说。'
  const hit = locateEvidence(body, '“不是。”')
  assert.equal(hit.quote, '“不是。”', '正文里本来就有引号 ⇒ 原样命中，quote 不应被剥离')
  assert.equal(hit.start, 0)
})

test('地点：门禁未被放松 —— 改写 / 换主语 / 编造 / 空证据一律拒绝', () => {
  const body = '她转过身，从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。'
  for (const [ev, why] of [
    ['“从书架上抽出一个崭新的牛皮纸本，放在桌上，推到我面前。”', '改了一个词'],
    ['“他转过身，从书架上抽出一个新的牛皮纸本”', '换了主语'],
    ['“明天中午，教室见。”', '内容被改写'],
    ['“这是一个完全编造的句子。”', '纯编造'],
    ['', '空证据'],
    ['“。”', '只有标点'],
  ]) {
    const hit = locateEvidence(body, ev)
    const pass = hit && isSpecificEvidence(ev)
    assert.equal(!pass, true, `必须拒绝：${why}`)
  }
})

test('端到端：带引号的证据经 commitDraft 也能提交（不再整章卡死）', () => {
  const p = story()
  const text = '“不是。”林舟说。他把铜钥匙放在桌上，翻开了档案。'
  const d = draftWith({
    summary: '林舟找到档案',
    facts: [{ text: '林舟翻开了档案', evidence: '“他把铜钥匙放在桌上，翻开了档案。”' }],
    states: [{ subject: '林舟', attribute: '持有', value: '档案', evidence: '“他把铜钥匙放在桌上，翻开了档案。”' }],
    knowledge: [], threads: [], resolved: [], foreshadows: [], reveals: [],
  }, text)
  const r = commitDraft(p, d, 1)
  const next = r.project || r
  assert.equal(next.chapters.find((c) => c.no === 2).status, 'committed')
  const fact = next.ledger.canonicalFacts.find((f) => f.text === '林舟翻开了档案')
  assert.ok(fact, '事实应入账')
  assert.equal(fact.trust, TRUST.CANONICAL, '证据真实存在 ⇒ 应标为 CANONICAL，而非 NEEDS_REVIEW')
  assert.equal(fact.sourceSpan.quote, '他把铜钥匙放在桌上，翻开了档案。',
    'span.quote 必须是正文原文（已剥掉模型加的引号），保证能落回正文定位')
})

/* --------- 全量压测第 2 章现场：模型把「隔着插叙的同一句」拼成一条引文 --------- */
/**
 * 现场（真实付费 2624 字）：10 条证据里 6 条被判「未在正文中原样出现」，
 * 但逐条核对后**没有一条是编造**，全是三种「引用格式偏差」：
 *   ① 隔着插叙：`“这四天，”林晚把册子合上，“门都自己开了。”` 被拼成 `这四天，门都自己开了。`
 *   ② 省略号拼接：`那名单上有谁？……自己找。`（两段都在正文里，中间跳过了内容）
 *   ③ 省去叙述句：`她从书架最底层抽出…` 而正文是 `她没往下说，只是从书架最底层抽出…`
 * ⇒ 逐字 `includes` 必然失败 ⇒ 已付费正文整章交不进去。
 *
 * 修法：在「逐字」之外，增加**有护栏的**松散定位（实义字按顺序出现 + 匹配区间足够紧凑），
 * 并支持按省略号分段校验（各段必须按正文顺序出现）。
 */
test('重排容忍①：隔着插叙的同一句对白，应能定位（内容确实在正文里）', () => {
  const body = '“这四天，”林晚把册子合上，“门都自己开了。但只有昨天，有人进来了。”'
  const ev = '这四天，门都自己开了。但只有昨天，有人进来了。'
  assert.equal(body.includes(ev), false, '逐字确实匹配不上（这就是当时的失败）')
  const hit = locateEvidence(body, ev)
  assert.ok(hit, '应能松散定位')
  assert.ok(hit.quote.startsWith('这四天'), '命中片段应起于正文里的「这四天」')
})

test('重排容忍②：省略号拼接的引文，各段都在正文里且顺序一致 ⇒ 通过', () => {
  const body = '“那名单上有谁？”\n\n她把空茶壶搁在托盘上，发出一声很轻的响。\n\n“自己找。”'
  const hit = locateEvidence(body, '那名单上有谁？……自己找。')
  assert.ok(hit, '分段定位应成功')
  assert.ok(hit.quote.includes('自己找'), '应覆盖到后半段')
})

test('重排容忍③：省略号两段顺序颠倒 ⇒ 拒绝（不是「随便都能过」）', () => {
  const body = '“那名单上有谁？”\n\n她把空茶壶搁在托盘上。\n\n“自己找。”'
  assert.equal(locateEvidence(body, '自己找。……那名单上有谁？'), null,
    '后半段在正文里出现在前半段之前 ⇒ 属于拼凑，必须拒绝')
})

test('重排容忍④：松散匹配有护栏 —— 区间必须紧凑，跨全篇的拼凑不允许', () => {
  // 两个片段都真实存在，但相隔极远（> 核心长度×2 + 12）⇒ 不足以证明是同一条引文
  const far = '（甲）'.repeat(40) + '门都自己开了' + '（乙）'.repeat(40) + '有人进来了'
  assert.equal(locateEvidence(far, '门都自己开了。但只有昨天，有人进来了。'), null,
    '跨度超过护栏上限 ⇒ 必须拒绝')
})

test('重排容忍⑤：短证据不走松散路径（防止短句被误放行）', () => {
  // core < 8 的短证据必须逐字命中，否则容易在长文里「凑」出来
  const body = '她说：“合格。”然后合上了本子。'
  assert.ok(locateEvidence(body, '合格。'), '逐字存在的短证据正常通过')
  assert.equal(locateEvidence(body, '合格了。'), null, '改一个字的短证据仍应拒绝')
})
