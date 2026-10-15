/**
 * 数据 Schema v2
 *
 * 相比 v1 的三个结构性变化：
 *   1. **引入实体表 `entities`**：角色/地点/物品拥有稳定 ID，全文靠 ID 关联而非名字。
 *      这是「改名不失效」的前提，也是后续人物关系、角色认知、伏笔关联的基础。
 *   2. **状态账本拆成四类**：canonicalFacts / currentState / characterKnowledge / plotThreads，
 *      取代原来的 facts[] / threads[] 两个字符串数组。
 *   3. **版本与迁移记录**：headVersion（提交计数）+ schemaVersion + migrations 历史。
 *
 * ID 一律由内容派生（SHA-1 截断），因此**同一份数据重复迁移必然得到相同结果** ——
 * 迁移脚本据此可以安全地重复执行而不产生重复记录。
 */
import crypto from 'node:crypto'

export const SCHEMA_VERSION = 2

/**
 * 来源可信度（第 2 轮评审「任何标记都必须有明确运行行为」）。
 *
 * 这是**有运行后果**的字段，不是装饰：
 *   canonical           有可信来源（正文证据 / 作者设定）→ 可进入正文上下文
 *   legacy_unverified   来源缺失或无法确认（多为旧数据迁移）→ **隔离**，不进正文
 *   needsReview         待人工复核（模型推断、冲突未决）→ **隔离**，不进正文
 *
 * 隔离的条目**仍然完整保存在存储层**（可追溯、可回补来源），但一律不参与
 * WriterPacket 编译，只在 diagnostics.quarantined 里计数与列名，供人工处理。
 * 详见 docs/data-schema-v2.md「标记与运行行为对照表」。
 */
export const TRUST = {
  CANONICAL: 'canonical',
  LEGACY_UNVERIFIED: 'legacy_unverified',
  NEEDS_REVIEW: 'needsReview',
}

/**
 * 伏笔动作的合法取值与别名归一 —— **唯一实现**（开书路径与重排路径共用）。
 *
 * 模型经常把「这章要埋这条伏笔」写成中文或同义词（埋设/埋下/铺设、回收/揭晓、payoff）。
 * ⛔ 真实事故（2026-10-13 审计）：只有重排路径做了归一，**开书路径零归一零白名单**存原串，
 *    而消费端 `projection.projectForeshadows()` 只认 plant/reinforce/pay_off ⇒
 *    一条「埋设」被**静默丢弃** ⇒ 那一章没有 plant 指令 ⇒ 抽取侧不要求埋设
 *    ⇒ 账本没有 plant 事件 ⇒ 回收章判 `not-planted` ⇒ **那一章永久写不出来**（¥0，死在模型调用前）。
 */
/**
 * 名字归一（canon）：`林奇` / `林 奇` / `LIN QI` 视为同一个。
 * ⛔ 只 `trim()` 而不做 canon 时，「名字中间被模型插了个空格」这种漂移会白白丢掉整条选角。
 */
export const canonName = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_]/g, '')

/**
 * 把模型给的 cast 写成**实体 ID 数组** —— 全项目**唯一实现**。
 *
 * 为什么必须唯一：开书路径原来自己写了一句
 * `cast.map(n => nameToId.get(String(n).trim())).filter(Boolean)`
 * —— **零 canon、零别名、还静默丢弃**；而重排路径这份有 canon、认别名、并且**记一条 warning**。
 * 同一份数据在两条路径上的角色可见性因此不同（开书丢人、重排不丢）。
 *
 * 返回 `{ ids, unresolved }`：`unresolved` 是**认不出来的名字**（已去重）。
 * ⛔ 调用方**不能**把它们静默扔掉：要么记 warning、要么挂到章节上让界面显示出来
 *（「静默丢人」正是这条 bug 的病根）。
 */
export function normalizeCastIds(rawList, project, warnings = []) {
  if (!Array.isArray(rawList)) return { ids: [], unresolved: [] }
  const entities = project?.entities || []
  const byId = new Map(entities.map((e) => [e.id, e]))
  const byName = new Map()
  for (const e of entities) {
    for (const n of [e.name, ...(e.aliases || [])]) {
      const k = String(n ?? '').trim()
      if (k) { byName.set(k, e.id); byName.set(canonName(k), e.id) }
    }
  }
  const byCanonId = new Map(entities.map((e) => [canonName(e.id), e.id]))
  const ids = new Set()
  const unresolved = new Set()
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue
    const key = raw.trim()
    if (!key) continue
    if (byId.has(key)) { ids.add(key); continue }
    if (byName.has(key)) { ids.add(byName.get(key)); continue }
    if (byName.has(canonName(key))) { ids.add(byName.get(canonName(key))); continue }
    const hit = byCanonId.get(canonName(key))
    if (hit) { ids.add(hit); continue }
    // 同一个名字出现多次只记一条（否则满屏重复告警，等于没有告警）
    if (!unresolved.has(key)) {
      unresolved.add(key)
      warnings.push(`引用了不存在的角色 ${JSON.stringify(key.slice(0, 24))}，已忽略`)
    }
  }
  return { ids: [...ids], unresolved: [...unresolved] }
}

/**
 * 剥掉模型爱加的代码围栏（```json … ```）。**全项目唯一实现**。
 * ⛔ 它原来在 `pipeline.js` 与 `workflow.js` 各写了一份（workflow 那份还是内联箭头函数）。
 */
export function stripFence(s) {
  return String(s ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

/**
 * 正文清洗 —— **送进正式正文之前必须过这一道**。
 *
 * 模型即使被明确要求「不要输出章标题、不要写『以下是正文』」，也常会加：
 *   ① 开头一行「第一章 格口十二」（或带 `#`/`##`）；
 *   ② 「以下是正文：」「正文：」；
 *   ③ 一条 `---` 分隔线。
 * 这些一旦落进 `chapters[].text` 就**洗不掉了**（已定稿正文永不自动改写），读者会直接看到。
 *
 * ⛔ 病灶（2026-10-14 找到）：这个函数原来**只被 `pipeline.generateChapter()` 调用**，
 *    而那个函数**一个活调用者都没有**（死代码）⇒ 活路径 `workflow.js` 提交的是模型原文，
 *    只做了 `stripFence`。**「清洗逻辑在死路径上、活路径没有」是本项目栽过多次的同一个坑。**
 *    现在：清洗搬到 schema.js（唯一实现），活路径显式调用。
 *
 * ⚠️ 只清理**开头**的这几类噪声，绝不动正文内容本身（不做任何改写/截断/润色）。
 */
export function cleanBody(text) {
  let t = stripFence(text)
  t = t.replace(/^#*\s*第\s*[0-9一二三四五六七八九十百]+\s*章[^\n]*\n+/, '')
  t = t.replace(/^\s*(正文|以下是正文|正文如下)[：:]\s*\n*/, '')
  t = t.replace(/^[-—=*]{3,}\s*\n/, '')
  return t.trim()
}

export const FORESHADOW_ACTION_ALIASES = {
  plant: 'plant', reinforce: 'reinforce', payoff: 'pay_off', pay_off: 'pay_off',
  铺设: 'plant', 埋设: 'plant', 埋下: 'plant', 强化: 'reinforce', 回收: 'pay_off', 揭晓: 'pay_off',
}
export function normalizeForeshadowAction(rawAction) {
  const raw = String(rawAction ?? '').trim()
  const key = raw.toLowerCase().replace(/[\s\-]/g, '_')
  return FORESHADOW_ACTION_ALIASES[key] || FORESHADOW_ACTION_ALIASES[raw] || null
}

/** 只有这个值允许进入正文上下文 */
export const TRUST_IN_WRITER_CONTEXT = new Set([TRUST.CANONICAL])

export function isTrusted(entry) {
  return TRUST_IN_WRITER_CONTEXT.has(entry?.trust ?? TRUST.CANONICAL)
}

const now = () => new Date().toISOString()
const digest = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10)

/**
 * 归一化文本：仅用于**派生 ID**，不改动存储的原文。
 * 目的：让「同一句话的标点/空白差异」不产生两条记录。
 */
export function normalizeText(s) {
  return String(s ?? '')
    .trim()
    .replace(/[\s]+/g, '')
    .replace(/[。．.!！?？,，;；:：、]+$/, '')
}

/* ------------------------------- 确定性 ID ------------------------------- */

/* --------------------------- 章节名归一化 --------------------------- */

/**
 * 剥掉章节名里**自带的中文章节序号前缀**，只保留真正的标题。
 *
 * 背景：大纲模型习惯把章标题写成「第一章 撞飞会长的一百种方式」，
 * 而 UI 渲染时会在前面另加「第 N 章」，于是显示成
 * 「第1章　第一章 撞飞会长的一百种方式」——同一个序号出现两次。
 * 用户手改章名时同样可能输入「第十二章 xxx」。
 *
 * ⚠️ 这是**显示层重复**，不是数据损坏：正文里的「第一章」标题行照旧由
 * 章节记录自身的 no 决定，此处只清理 title 字段的冗余前缀。
 *
 * 覆盖三种写法：中文数字（第一章 / 第1章）、三位以上阿拉伯数字、
 * 以及以「序章 / 楔子 / 尾声 / 终章」等非数字定位词开头的标题（保留其语义）。
 */
export function stripChapterTitlePrefix(title) {
  let t = String(title ?? '').trim()
  if (!t) return ''
  // 允许「第一章」「第 1 章」「第十二章」以及其后紧跟的 空格/冒号/顿号/点/连字符
  const re = /^第\s*[0-9零一二三四五六七八九十百千万两]{1,8}\s*[章回节篇卷]\s*[·・:：.、\-—]?\s*/u
  const next = t.replace(re, '').trim()
  // 全被吃掉（标题本身就是「第一章」）时保留原样，避免出现空标题
  return next || t
}

export function entityId(kind, name) {
  return `ent_${digest(`${kind}:${String(name).trim()}`)}`
}

export function factId(text) {
  return `fact_${digest(`fact:${normalizeText(text)}`)}`
}

/**
 * 状态记录的**身份**。
 *
 * 必须把「生效章节 + 章内序号」纳入派生（第 2 轮评审）：
 *   「档案馆@1 → 青江桥@2 → 又回档案馆@3」中，两次「档案馆」内容相同，
 *   若 ID 只由 subject|attribute|value 派生，第三条会被去重逻辑吃掉。
 *
 * 三个 ID 的职责区分（R2 会补齐后两个）：
 *   state_id        状态记录本身（本函数）——「当前是什么」
 *   event_id        一次实际发生的状态变化——「发生了什么」（R2）
 *   idempotency_key 防同一次操作被重复提交——「是否重复」（R2）
 */
export function stateId(subjectId, attribute, value, sinceChapter = null, eventSeq = 0) {
  const ch = sinceChapter === null || sinceChapter === undefined ? '-' : sinceChapter
  return `st_${digest(`${subjectId}|${attribute}|${value}|${ch}|${eventSeq}`)}`
}

/**
 * 认知记录的**身份**。
 *
 * `belief` 与 `sinceChapter` 必须参与派生：第 1 章「怀疑林晚遇害」与
 * 第 2 章「确信林晚遇害」是两种不同的认知状态，不能互相覆盖。
 */
export function knowledgeId(characterId, fact, belief = 'knows', sinceChapter = null, eventSeq = 0) {
  const ch = sinceChapter === null || sinceChapter === undefined ? '-' : sinceChapter
  // eventSeq 为 0 时不写入，保证与 R2 之前已落库的认知记录 ID 完全一致（迁移幂等）
  const tail = eventSeq ? `|${eventSeq}` : ''
  return `kn_${digest(`${characterId}|${belief}|${normalizeText(fact)}|${ch}${tail}`)}`
}

export function threadId(text) {
  return `th_${digest(`thread:${normalizeText(text)}`)}`
}

/**
 * 伏笔的稳定 ID。
 *
 * 第 2 轮评审问题 1：旧数据的伏笔 id 是空串，等于「有字段没有关联」。
 * 空 ID 是所有伏笔关联（章节 → 伏笔 → 线索）的断点，必须补齐。
 */
export function foreshadowId(seed) {
  return `fs_${digest(`foreshadow:${normalizeText(seed)}`)}`
}

/**
 * 状态**事件**的身份 —— 「发生了什么」。
 *
 * R2 要求：state_id / event_id / idempotency_key 三者各司其职，
 * **不允许**通过往同一个哈希里塞不同内容来逐个救场。三者的派生输入必须不同：
 *
 *   state_id        派生自「记录内容」  subject|attribute|value|章号|章内序号 → 标识一条状态记录
 *   event_id        派生自「一次转移」  subject|attribute|from|to|章号|章内序号 → 标识一次状态变化
 *   idempotency_key 派生自「提交来源」  见 opIdempotencyKey（章号|批次指纹|位置|内容）
 *
 * 因此「档案馆 → 青江桥 → 档案馆」中两次「档案馆」是**两条记录、两个事件**，
 * 各自可追溯；而「同一批抽取重复提交」不会因为内容相同被误判成新事件。
 */
export function stateEventId(subjectId, attribute, fromValue, toValue, chapterNo = null, seq = 0) {
  const ch = chapterNo === null || chapterNo === undefined ? '-' : chapterNo
  return `ev_${digest(`${subjectId}|${attribute}|${normalizeText(fromValue)}|${normalizeText(toValue)}|${ch}|${seq}`)}`
}

/**
 * 幂等键 —— 「这次提交是不是重复」。
 *
 * 由**提交来源**派生，与状态记录、事件都没有派生关系：
 *   章号 + 批次指纹(batchKey) + 变更内容 + 变更在批次中的位置(index)
 *
 * 两个必须同时成立的性质：
 *   · 同一批抽取结果重复提交 → batchKey 与 index 都相同 → 键完全相同 → 整批判定重复，不重复执行
 *   · 同一章内两次「内容相同」的变化 → 位置不同 → 键不同 → 是两个事件，各自生效
 * 这就是「重复提交同一事件不重复执行」与「同章多次相同变化可区分」不矛盾的根据：
 * 幂等键锚定的是**提交**，不是**结果**。
 */
export function opIdempotencyKey({ chapterNo = null, batchKey = '', kind = '', parts = [] } = {}) {
  const ch = chapterNo === null || chapterNo === undefined ? '-' : chapterNo
  return `ik_${digest([ch, batchKey, kind, ...parts.map((p) => normalizeText(p))].join('|'))}`
}

/** 正文内容的指纹：作为「这一次生成」的提交标识的一部分 */
export function contentFingerprint(text) {
  return `cf_${digest(String(text ?? ''))}`
}

/** 一次提交（一批抽取结果）的指纹：同一批内容必得同一指纹，保证幂等可判定 */
export function batchFingerprint(changes, chapterNo = null) {
  const ch = chapterNo === null || chapterNo === undefined ? '-' : chapterNo
  const sig = (changes || [])
    .map((c) =>
      [
        c?.kind || 'state',
        c?.subjectId ?? c?.characterId ?? '',
        c?.attribute ?? c?.fact ?? '',
        c?.value ?? c?.belief ?? '',
        c?.sinceChapter ?? '',
      ]
        .map((x) => normalizeText(x))
        .join('\u0001')
    )
    .join('\u0002')
  return `bf_${digest(`${ch}\u0003${sig}`)}`
}

/* -------------------------------- 实体工厂 -------------------------------- */

export const ENTITY_KINDS = ['character', 'place', 'item']

export function makeEntity({ kind = 'character', name, ...rest }) {
  const t = now()
  const cleaned = String(name ?? '').trim()
  return {
    id: entityId(kind, cleaned),
    kind,
    name: cleaned,
    aliases: [], // 别名：改名后旧名进这里，保证历史正文仍可检索
    publicRole: '',
    publicIdentity: '',
    authorRole: '',
    secret: null,
    want: '',
    fear: '',
    createdAt: t,
    updatedAt: t,
    ...rest,
  }
}

/* ------------------------------- 账本条目工厂 ------------------------------- */

/**
 * 已确立的稳定事实 / 世界规则。不因条数截断。
 *
 * @param {string|null} sourceChapter  出处章节；null = 来源未知或作品级设定
 * @param {string} trust               来源可信度，见 TRUST
 * @param {number|null} storyTime      叙事时间线位置（倒叙/同章内时序用）。
 *                                     MVP 尚未填充，接口先留出 —— 见 isVisibleAt()。
 */
export function makeFact({
  text,
  entityIds = [],
  sourceChapter = null,
  sourceSpan = null,
  visibility = 'public',
  verified = true,
  status = 'active',
  trust = TRUST.CANONICAL,
  storyTime = null,
}) {
  const t = String(text ?? '').trim()
  return {
    id: factId(t),
    text: t,
    entityIds,
    sourceChapter,
    sourceSpan,
    visibility,
    verified,
    status,
    trust,
    storyTime,
    createdAt: now(),
  }
}

/**
 * 当前地点、持有物品、伤势、关系状态 —— 可逆但有剧情前提作用。
 *
 * R2 新增字段都是为了「状态转移」能自洽：
 *   status         active | superseded —— 同一 (subject, attribute) 下只应有一条 active
 *   untilChapter   被替代的章号（active 时为 null），支撑「查询指定章节的有效状态」
 *   supersededBy   取代它的记录 id，形成可追溯的转移链
 *   eventId        产生本记录的那次转移事件（见 stateEventId）
 *   sourceChapter / sourceVersion / sourceSpan  证据溯源：哪一章、哪个正文版本、正文哪个位置
 */
export function makeState({
  subjectId,
  attribute,
  value,
  sinceChapter = null,
  status = 'active',
  visibility = 'public',
  trust = TRUST.CANONICAL,
  storyTime = null,
  eventSeq = 0,
  eventId = null,
  untilChapter = null,
  supersededBy = null,
  sourceChapter = null,
  sourceVersion = null,
  sourceSpan = null,
}) {
  const a = String(attribute ?? '')
  const v = String(value ?? '')
  return {
    id: stateId(subjectId, a, v, sinceChapter, eventSeq),
    subjectId,
    attribute: a,
    value: v,
    sinceChapter,
    status,
    untilChapter,
    supersededBy,
    eventId,
    visibility,
    trust,
    storyTime,
    eventSeq,
    sourceChapter: sourceChapter ?? sinceChapter,
    sourceVersion,
    sourceSpan,
    createdAt: now(),
  }
}

/** 谁知道、谁误信、谁怀疑。R2 起支持认知演变：suspects → knows 保留历史、只切换当前项 */
export function makeKnowledge({
  characterId,
  fact,
  belief = 'knows', // knows | believes | suspects
  sinceChapter = null,
  status = 'active',
  visibility = 'public',
  trust = TRUST.CANONICAL,
  storyTime = null,
  eventSeq = 0,
  eventId = null,
  untilChapter = null,
  supersededBy = null,
  sourceChapter = null,
  sourceVersion = null,
  sourceSpan = null,
}) {
  const f = String(fact ?? '').trim()
  return {
    id: knowledgeId(characterId, f, belief, sinceChapter, eventSeq),
    characterId,
    fact: f,
    belief,
    sinceChapter,
    status,
    untilChapter,
    supersededBy,
    eventId,
    visibility,
    trust,
    storyTime,
    eventSeq,
    sourceChapter: sourceChapter ?? sinceChapter,
    sourceVersion,
    sourceSpan,
    createdAt: now(),
  }
}

/** 伏笔/悬念的生命周期与回收进度 */
export function makeThread({
  text,
  foreshadowId = null,
  status = 'open', // open | planted | reinforced | paid_off | abandoned
  plantedAt = null,
  sourceChapter = null,
  visibility = 'public',
  trust = TRUST.CANONICAL,
  storyTime = null,
}) {
  const t = String(text ?? '').trim()
  return {
    id: threadId(t),
    text: t,
    foreshadowId,
    status,
    plantedAt,
    reinforcedAt: [],
    paidOffAt: null,
    sourceChapter,
    visibility,
    trust,
    storyTime,
    createdAt: now(),
  }
}

export function emptyLedger() {
  return {
    canonicalFacts: [],
    currentState: [],
    characterKnowledge: [],
    plotThreads: [],
    // R2：状态转移的事件日志。是「发生了什么」的权威记录 ——
    // 幂等判定、证据溯源、历史回放都读它，而不是反推状态记录的差异。
    stateEvents: [],
    foreshadowEvents: [], // R3：实际铺设/回收的正文证据，不与计划混淆
  }
}

/**
 * 一次状态/认知转移的事件记录。
 *
 * kind='state' 时   subjectId=主体, attribute=属性, toValue=新值
 * kind='knowledge' 时 subjectId=角色, attribute='belief', toValue=新认知(knows/believes/suspects)
 */
export function makeStateEvent({
  kind = 'state',
  subjectId,
  attribute,
  fromValue = null,
  toValue = null,
  fromStateId = null,
  toStateId = null,
  chapterNo = null,
  seq = 0,
  idempotencyKey = null,
  batchKey = null,
  seqKey = null,
  trust = TRUST.CANONICAL,
  sourceChapter = null,
  sourceVersion = null,
  sourceSpan = null,
}) {
  const src = sourceChapter ?? chapterNo
  return {
    id: stateEventId(subjectId, attribute, fromValue, toValue, chapterNo, seq),
    kind,
    subjectId,
    attribute: String(attribute ?? ''),
    fromValue: fromValue === null || fromValue === undefined ? null : String(fromValue),
    toValue: toValue === null || toValue === undefined ? null : String(toValue),
    fromStateId,
    toStateId,
    chapterNo,
    seq,
    idempotencyKey,
    // batchKey 是**提交标识**：幂等判定以它为准，而不是以内容为准。
    // seqKey 是该事件所属的「主体|属性|章号」桶，用于给后续批次分配不撞车的序号。
    batchKey,
    seqKey,
    sourceChapter: src,
    sourceVersion,
    sourceSpan,
    trust,
    createdAt: now(),
  }
}

/* --------------------------------- 校验 --------------------------------- */

/**
 * 结构一致性检查：防「悬空引用」与「非法标记」。
 * 返回问题列表，空数组表示通过。
 *
 * 检查项：
 *   - 实体 id 缺失 / 重复 / 缺 name
 *   - 大纲与章节的 cast 引用不存在的实体
 *   - 账本条目引用不存在的实体
 *   - trust 取值非法（会导致隔离行为判断失效，必须拦下）
 */
export function validateProject(p) {
  const issues = []
  if (!p || typeof p !== 'object') return ['作品对象为空']

  const entities = Array.isArray(p.entities) ? p.entities : []
  const ids = new Set(entities.map((e) => e.id))
  const legalTrust = new Set(Object.values(TRUST))

  // 实体自身
  const seen = new Set()
  for (const e of entities) {
    if (!e.id) issues.push('存在没有 id 的实体')
    if (seen.has(e.id)) issues.push(`实体 id 重复：${e.id}`)
    seen.add(e.id)
    if (!e.name) issues.push(`实体 ${e.id} 缺少 name`)
  }

  // 大纲的 cast 与章节 cast 应引用实体
  for (const e of p.outline?.cast || []) {
    if (e.entityId && !ids.has(e.entityId)) issues.push(`大纲角色引用了不存在的实体 ${e.entityId}`)
  }
  for (const v of p.outline?.volumes || []) {
    for (const c of v.chapters || []) {
      for (const id of c.cast || []) {
        if (!ids.has(id)) issues.push(`第 ${c.no} 章的 cast 引用了不存在的实体 ${id}`)
      }
    }
  }

  // 账本引用 + trust 合法性
  const led = p.ledger || {}
  const trustIssue = (kind, item) => {
    const t = item?.trust
    if (t !== undefined && t !== null && !legalTrust.has(t)) {
      issues.push(`${kind} ${item.id} 的 trust 取值非法：${t}`)
    }
  }
  for (const f of led.canonicalFacts || []) {
    for (const id of f.entityIds || []) {
      if (!ids.has(id)) issues.push(`事实 ${f.id} 引用了不存在的实体 ${id}`)
    }
    trustIssue('事实', f)
  }
  for (const s of led.currentState || []) {
    if (s.subjectId && !ids.has(s.subjectId)) issues.push(`状态 ${s.id} 引用了不存在的实体 ${s.subjectId}`)
    trustIssue('状态', s)
  }
  for (const k of led.characterKnowledge || []) {
    if (k.characterId && !ids.has(k.characterId)) {
      issues.push(`认知 ${k.id} 引用了不存在的实体 ${k.characterId}`)
    }
    trustIssue('认知', k)
  }
  for (const f of p.outline?.foreshadows || []) {
    const plan = [f.plantChapter ?? f.plantAt, f.payoffChapter ?? f.revealAt]
    for (const no of plan) {
      if (no != null && (!Number.isInteger(Number(no)) || Number(no) < 1)) issues.push(`伏笔 ${f.id} 的计划章号无效`)
    }
  }
  const fsIds = new Set((p.outline?.foreshadows || []).map((f) => f.id))
  for (const v of p.outline?.volumes || []) for (const c of v.chapters || []) {
    for (const action of c.foreshadows || []) if (!fsIds.has(action.id)) issues.push(`第 ${c.no} 章引用不存在的伏笔 ${action.id}`)
  }
  for (const e of led.foreshadowEvents || []) {
    if (e.foreshadowId && !fsIds.has(e.foreshadowId)) issues.push(`证据事件 ${e.id} 引用了不存在的伏笔 ${e.foreshadowId}`)
    trustIssue('伏笔事件', e)
  }
  for (const t of led.plotThreads || []) {
    trustIssue('线索', t)
  }

  // 伏笔 ID 必须非空（第 2 轮评审问题 1：空串等于没有关联）
  for (const f of p.outline?.foreshadows || []) {
    if (!f.id) issues.push(`大纲存在没有 id 的伏笔：${String(f.seed || '').slice(0, 24)}`)
  }

  return issues
}

/* ------------------------------- 空项目骨架 ------------------------------- */

export function emptyProjectShell() {
  return {
    schemaVersion: SCHEMA_VERSION,
    headVersion: 0,
    entities: [],
    ledger: emptyLedger(),
    migrations: [],
  }
}
