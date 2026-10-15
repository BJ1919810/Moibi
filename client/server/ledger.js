/**
 * 状态账本（四类）
 *
 * 四类数据的职责划分（第 1 轮评审第 2 条）：
 *   canonicalFacts      已确立的稳定事实、世界规则 —— 不因条数截断
 *   currentState        当前地点、持有物、伤势、关系状态 —— 可逆，但决定下一章能写什么
 *   characterKnowledge  谁知道 / 谁误信 / 谁怀疑
 *   plotThreads         伏笔与悬念的生命周期
 *
 * 两条铁律：
 *   1. **存储层不截断**。历史事实永不因「超过 N 条」被删除 ——
 *      倒叙、历史调查、伏笔回收都要回查旧记录。
 *   2. **上下文层按相关性挑选**。每次只把当前有效且相关的一小部分交给模型，
 *      通过稳定 ID 与显式关联筛选，不做向量检索。
 */
import { emptyLedger, makeFact, makeState, makeKnowledge, makeThread, TRUST } from './schema.js'
import { applyStateChanges } from './state-engine.js'

const KINDS = ['canonicalFacts', 'currentState', 'characterKnowledge', 'plotThreads', 'stateEvents', 'foreshadowEvents']

export function ensureLedger(project) {
  if (!project.ledger) project.ledger = emptyLedger()
  for (const k of KINDS) {
    if (!Array.isArray(project.ledger[k])) project.ledger[k] = []
  }
  return project.ledger
}

/** 按 id 去重追加，返回新增条数 */
function appendUnique(arr, items) {
  const seen = new Set(arr.map((x) => x.id))
  let added = 0
  for (const it of items) {
    if (!it || !it.id || seen.has(it.id)) continue
    seen.add(it.id)
    arr.push(it)
    added++
  }
  return added
}

/**
 * 证据「是否足够具体」的中文友好判据。
 *
 * 中文对白型证据天然极短 —— 最自然、最精确的形式恰恰是短句："不是。" "嗯。" "坐。"。
 * 旧的 `evidence.length >= 4` 是英文思维（英文单词最短 2–3 字母），会把真实存在、
 * 且能在正文中逐字定位的中文证据误杀。
 *
 * 这里改为：**去掉空白与标点后仍有 ≥2 个实义字符** 即视为「够具体」。
 * 是否可信仍必须由调用方用 `includes()` 在正文里原文精确定位来判定 —— 安全性不降
 * （编造或改写过的引文依旧定位不到）。
 */
export const MIN_EVIDENCE_CORE = 2
export function evidenceCore(evidence) {
  return String(evidence == null ? '' : evidence).replace(/[\s\p{P}\p{S}]/gu, '')
}
export function isSpecificEvidence(evidence) {
  return evidenceCore(evidence).length >= MIN_EVIDENCE_CORE
}

/**
 * 外层「引号/括号」类包裹字符。模型引用正文时习惯把引文整段包起来
 * （`“她转过身，从书架上抽出……”`），而正文里那句话**本身不带这层引号**。
 * 这层包裹是**引用格式**，不是正文内容 ⇒ 匹配时应剥掉。
 *
 * ⚠️ 只剥**成对包裹整个字符串**的最外层符号，绝不做全局替换：
 *   正文里的引号是实义内容（对白），全局去掉会放松门禁、让改写过的引文也能命中。
 */
const QUOTE_WRAP = /^[\s"'“”‘’「」『』【】〔〕（）()《》〈〉\[\]{}]+|[\s"'“”‘’「」『』【】〔〕（）()《》〈〉\[\]{}]+$/gu

/** 省略标记：模型用它在同一条引文里跳过不重要部分（`甲。……乙。`）。 */
const ELISION = /\s*(?:…+|\.{3,}|⋯+|。{3,}|\*{3,})\s*/gu

const CONTENT_PUNCT = /[\s\p{P}\p{S}]/u
/** 与 `evidenceCore` 同义：该字符会被保留（字母/数字，CJK 属字母）。 */
const isContentChar = (ch) => !CONTENT_PUNCT.test(ch)

/** 松散匹配护栏：核心长度下限；允许的最大膨胀倍数；额外余量。 */
const MIN_LOOSE_CORE = 8
const MAX_LOOSE_EXPANSION = 2
const LOOSE_SLACK = 12

/**
 * 松散定位：忽略空白/标点后，要求证据的**实义字符按顺序**出现在正文里，
 * 且整段匹配区间足够紧凑（跨度 ≤ 核心长度×2 + 12，核心 ≥ 8 字）。
 *
 * 为什么需要它（全量压测实测，第 2 章 6 条证据全栽在这）：
 *   模型常把**隔着插叙的同一句对白**拼成一条引文，例如
 *     evidence: `这四天，门都自己开了。但只有昨天，有人进来了。`
 *     正文    : `“这四天，”林晚把册子合上，“门都自己开了。但只有昨天，有人进来了。”`
 *   内容一字不差，只是中间夹了 `林晚把册子合上，`。再如
 *     evidence: `她从书架最底层抽出一本旧册子…`
 *     正文    : `她没往下说，只是从书架最底层抽出一本旧册子…`
 *   ⇒ 逐字 `includes` 必然失败，已付费正文整章交不进去。
 *
 * 安全性：仍是「实义字必须按顺序出现 + 区间必须紧凑」，
 *   编造句（出现不存在的字）/ 改写字（顺序对不上）/ 拼凑远距离片段（跨度超标）全部过不了。
 *   短证据（<8 实义字）**不走**此路径，必须逐字命中 —— 避免短句被松散匹配误放行。
 */
function looseLocate(src, evidence) {
  const eCore = evidenceCore(evidence)
  if (eCore.length < MIN_LOOSE_CORE) return null
  // 正文的「实义字串」及其回原始下标的映射
  const map = []
  let tCore = ''
  for (let i = 0; i < src.length; i++) {
    if (isContentChar(src[i])) { tCore += src[i]; map.push(i) }
  }
  if (!tCore) return null
  const limit = Math.ceil(eCore.length * MAX_LOOSE_EXPANSION) + LOOSE_SLACK
  // 字符 → 升序位置表，用于「找下一个出现」
  const pos = new Map()
  for (let i = 0; i < tCore.length; i++) {
    const arr = pos.get(tCore[i])
    if (arr) arr.push(i); else pos.set(tCore[i], [i])
  }
  const nextFrom = (ch, from) => {
    const arr = pos.get(ch)
    if (!arr) return -1
    let lo = 0, hi = arr.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < from) lo = m + 1; else hi = m }
    return lo < arr.length ? arr[lo] : -1
  }
  let best = null
  for (const anchor of pos.get(eCore[0]) || []) {
    let j = anchor
    let ok = true
    for (let k = 0; k < eCore.length; k++) {
      const p = nextFrom(eCore[k], j)
      if (p < 0) { ok = false; break }
      j = p + 1
    }
    if (!ok) continue
    const span = (j - 1) - anchor + 1
    if (span <= limit && (!best || span < best.span)) best = { a: anchor, b: j - 1, span }
  }
  if (!best) return null
  const start = map[best.a]
  const end = map[best.b] + 1
  return { start, end, quote: src.slice(start, end) }
}

/** 单个片段：原样 → 剥外层引用符 → 松散。 */
function locateFragment(src, frag) {
  const i = src.indexOf(frag)
  if (i >= 0) return { start: i, end: i + frag.length, quote: frag }
  const stripped = frag.replace(QUOTE_WRAP, '').trim()
  if (stripped && stripped !== frag) {
    const j = src.indexOf(stripped)
    if (j >= 0) return { start: j, end: j + stripped.length, quote: stripped }
  }
  return looseLocate(src, stripped || frag)
}

/**
 * 在正文中**定位**证据（证据门禁的唯一入口）。
 *
 * 语义（**安全性不降**）：证据的内容必须真的存在于正文里，只是容忍模型表达引用时的
 * 三种「格式偏差」：
 *   ① **外层引号包裹** —— `“从书架上抽出……”`，正文那句本身不带引号；
 *   ② **省略号拼接** —— `甲。……乙。`，两段都在正文里，只是中间跳过了内容；
 *   ③ **隔着插叙的同一句** —— `“这四天，”林晚把册子合上，“门都自己开了。”` 被拼成一句。
 * 处理顺序：原样 → 剥外层引用符 → 按省略号切段逐段定位（要求位置递增）→ 松散定位。
 * 全都失败 ⇒ 返回 `null`，调用方照旧拒绝。
 *
 * 真实踩坑（v2.0.0 全量压测）：第 1 章 2584 字、第 2 章 2624 字**均已付费**，
 *   各自 10 条证据里有 7 条 / 6 条因上述格式偏差被判「未在本章正文中原样出现」⇒ 整章拒稿。
 *   实测这些证据的内容**逐字都在正文里**，没有一条是编造。
 *
 * @returns {{start:number, end:number, quote:string}|null}
 *   命中区间与**实际匹配到的正文片段**（注意：是正文原文，不是模型给的带引号版本，
 *   这样 sourceSpan 才能精确落回正文）。
 */
export function locateEvidence(text, evidence) {
  const src = String(text == null ? '' : text)
  const raw = String(evidence == null ? '' : evidence).trim()
  if (!src || !raw) return null
  const frags = raw.split(ELISION).map((s) => s.trim()).filter(Boolean)
  const parts = []
  for (const frag of frags.length ? frags : [raw]) {
    const hit = locateFragment(src, frag)
    if (!hit) return null
    parts.push(hit)
  }
  // 各段必须按正文顺序出现，否则是拼凑
  for (let i = 1; i < parts.length; i++) if (parts[i].start < parts[i - 1].end) return null
  const start = parts[0].start
  const end = parts[parts.length - 1].end
  return { start, end, quote: src.slice(start, end) }
}

/* -------------------------------- 写入 -------------------------------- */

/*
 * 说明（R2）：下面四个 add* 是**低层写入**，只做按 id 去重追加，
 * 不处理「替代 / 转移 / 幂等」。状态与认知的正式入口是
 * `applyExtraction`（内部走 state-engine），请不要在业务代码里直接调 addStates / addKnowledge。
 * 保留导出仅为兼容既有测试与迁移工具。
 */

export function addFacts(project, entries) {
  return appendUnique(ensureLedger(project).canonicalFacts, entries)
}

export function addStates(project, entries) {
  return appendUnique(ensureLedger(project).currentState, entries)
}

export function addKnowledge(project, entries) {
  return appendUnique(ensureLedger(project).characterKnowledge, entries)
}

export function addThreads(project, entries) {
  return appendUnique(ensureLedger(project).plotThreads, entries)
}

/**
 * 把线索标记为已了结。
 * 注意：只改状态，**不删除** —— 已回收的线索仍要可查。
 */
export function resolveThreads(project, texts) {
  const l = ensureLedger(project)
  const wanted = new Set((texts || []).map((t) => String(t).trim()))
  let n = 0
  for (const t of l.plotThreads) {
    if (wanted.has(t.text)) {
      t.status = 'paid_off'
      t.paidOffAt = new Date().toISOString()
      n++
    }
  }
  return n
}

/**
 * 标记某条状态失效（例如物品转手、伤势痊愈），历史记录保留。
 *
 * ⛔ 这里原来写的是 `s.supersededAtChapter = atChapter` —— 一个**只写不读**的野字段：
 *    全项目没有任何地方读它，而**真正被读**的失效边界是 `untilChapter`
 *    （`state-engine` 判「第 N 章的有效状态」时读 `chOf(rec.untilChapter)`）。
 *    ⇒ 凡是用这个函数失效的状态，在时间边界上都会被当成**永远有效**（同一条判据两个键名，
 *      正是本项目的老病；活路径 `state-engine` 写的本来就是对的）。
 *    现在改写规范字段 `untilChapter`，那个野字段彻底不再出现。
 *    ⚠️ `supersededBy`（取代它的那条记录的 id）在这里拿不到，留 null；
 *      需要形成可追溯的转移链请走 state-engine 的路径。
 */
export function supersedeState(project, stateId, atChapter = null) {
  const l = ensureLedger(project)
  const s = l.currentState.find((x) => x.id === stateId)
  if (!s) return false
  s.status = 'superseded'
  if (atChapter != null) s.untilChapter = Number(atChapter)
  else if (s.untilChapter === undefined) s.untilChapter = null
  return true
}

/* ------------------------------- 上下文筛选 ------------------------------- */

/**
 * 条目的**有效可信度**。
 *
 * 优先读显式 trust；未标注时按「有无出处」推断 —— 这条兜底规则是刻意的：
 *   有出处 → 可追溯到正文，视为可信
 *   无出处 → 无法判断它属于哪一章，**一律隔离**
 *
 * 这样即使某份数据忘了标 trust（例如旧版本迁移留下的），也不会被默认放行。
 * 第 2 轮评审的「标记必须有运行行为」正是指这个 —— 默认值是行为，不是装饰。
 */
export function effectiveTrust(entry) {
  const t = entry?.trust
  if (t === TRUST.CANONICAL || t === TRUST.LEGACY_UNVERIFIED || t === TRUST.NEEDS_REVIEW) return t
  const src = entry?.sourceChapter ?? entry?.sinceChapter ?? null
  return src === null || src === undefined ? TRUST.LEGACY_UNVERIFIED : TRUST.CANONICAL
}

/**
 * 时间可见性判定（第 2 轮评审问题 5b）。
 *
 * MVP 只实现**章节边界**：出处章号 ≤ 当前章。
 *
 * 已知局限（不掩饰）：同章内的先后顺序、倒叙、多线并行尚未处理。
 * 为此保留 `storyTime` 接口 —— 当条目带 storyTime 且调用方给出 storyTime 时，
 * 改用它做同章内比较；未启用时自动退化为章节边界。
 */
export function isVisibleAt(entry, { chapterNo = Infinity, storyTime = null } = {}) {
  const src = entry?.sourceChapter ?? entry?.sinceChapter ?? null
  if (src !== null && src !== undefined && Number.isFinite(chapterNo) && src > chapterNo) {
    return { visible: false, reason: 'future-chapter' }
  }
  const st = entry?.storyTime
  if (storyTime !== null && st !== null && st !== undefined && st > storyTime) {
    return { visible: false, reason: 'future-story-time' }
  }
  return { visible: true, reason: 'ok' }
}

const byChapterDesc = (a, b) => {
  const ca = a.sourceChapter ?? a.sinceChapter ?? -1
  const cb = b.sourceChapter ?? b.sinceChapter ?? -1
  return cb - ca
}

/**
 * 挑选本次要交给模型的一小部分账本内容。
 *
 * 与传统「末 N 条」的区别：**先按显式关联挑，再按时间就近补足**。
 * 第 1 章埋下的线索只要仍与本章实体/伏笔相关，就不会因为「很久没提到」而被淘汰。
 *
 * 三项过滤（缺一不可）：
 *   1. 可见性：secret 一律剔除；
 *   2. 可信度：非 canonical 的一律隔离，进入 `quarantined` 供人工处理；
 *   3. 时间边界：出处章号晚于本章的一律剔除，进入 `futureSkipped`。
 *
 * 超预算时**不静默截断**：未入选的条目 ID 会出现在 `truncated.droppedIds`。
 * 排序改为按章号降序 —— 保证晚期新事实不会因为早期事实堆积而被挤掉。
 *
 * @param {object} opts
 * @param {number} opts.chapterNo        当前章号
 * @param {string[]} opts.entityIds      本章出场实体的 ID
 * @param {string[]} opts.foreshadowIds  本章涉及的伏笔 ID
 * @param {string[]} opts.requiredIds    本章**必需**的账本条目 ID（由 L2 规划给出）。
 *                                       必需项优先纳入，若因时间边界不可见则报告，不静默丢弃。
 * @param {number|null} opts.storyTime   叙事时间点（接口预留，MVP 未启用）
 * @param {object} opts.budget           条数上限
 */
/**
 * 「这条账本条目能不能进正文上下文」的**唯一判据**。
 * 返回：usable（可以进）/ quarantined（不可信，隔离）/ future（时间边界之外）/ hidden（secret）。
 *
 * ⛔ 真实事故（2026-10-13 审计，已在内存复现）：`projection.js` 的「已完成清单」通道
 *    自己写了一遍过滤、而且**只看 status** ⇒ 一条 `trust:'needsReview'` 或
 *    `visibility:'secret'` 的线索，只要被置成 `paid_off`/`abandoned`，原文就会**逐字进正文提示词**
 *    ——「非 canonical 隔离」与「secret 永不进正文」两条声明同时失效；
 *    而 `findLeaks()` 根本不扫账本 ⇒ **没有任何一层会报警**。
 *    ⇒ 这类判据必须只有一处实现，别的通道一律调它。
 */
export function classifyEntry(entry, { chapterNo = null, storyTime = null } = {}) {
  if (!entry) return 'hidden'
  if ((entry.visibility || 'public') === 'secret') return 'hidden'
  if (effectiveTrust(entry) !== TRUST.CANONICAL) return 'quarantined'
  if ((chapterNo != null || storyTime != null) && !isVisibleAt(entry, { chapterNo, storyTime }).visible) return 'future'
  return 'usable'
}

/** 便捷判据：只关心「能不能进正文」。 */
export function isWriterVisible(entry, opts) {
  return classifyEntry(entry, opts) === 'usable'
}

export function selectContext(project, opts = {}) {
  const l = ensureLedger(project)
  const { chapterNo = Infinity, entityIds = [], foreshadowIds = [], requiredIds = [], storyTime = null, budget = {} } = opts
  const { maxFacts = 30, maxThreads = 20 } = budget
  const focus = new Set(entityIds)
  const fset = new Set(foreshadowIds.filter(Boolean))
  const required = new Set(requiredIds.filter(Boolean))

  const quarantined = { facts: [], states: [], knowledge: [], threads: [] }
  const futureSkipped = { facts: 0, states: 0, knowledge: 0, threads: 0 }
  const requiredMissing = []

  /** 三态过滤：判据在模块级 `classifyEntry`（只此一处），这里只负责记诊断桶 */
  function classify(entry, bucket) {
    const verdict = classifyEntry(entry, { chapterNo, storyTime })
    if (verdict === 'quarantined') quarantined[bucket].push(entry.id)
    else if (verdict === 'future') futureSkipped[bucket]++
    return verdict
  }

  /* --- 事实：必需项强制优先 → 相关 → 其余按章号降序 --- */
  const factUsable = []
  for (const f of l.canonicalFacts) {
    if (f.status !== 'active') continue
    const c = classify(f, 'facts')
    if (c === 'usable') factUsable.push(f)
  }
  const factRelated = factUsable.filter((f) => (f.entityIds || []).some((id) => focus.has(id)))
  const factRest = factUsable.filter((f) => !factRelated.includes(f))
  const factRequired = factUsable.filter((f) => required.has(f.id))
  const factOrdered = [
    ...factRequired,
    ...factRelated.filter((f) => !required.has(f.id)).sort(byChapterDesc),
    ...factRest.sort(byChapterDesc),
  ]
  const facts = factOrdered.slice(0, maxFacts)
  const factDropped = factOrdered.slice(maxFacts)
  for (const id of required) {
    const hit = factUsable.find((f) => f.id === id)
    if (!hit) requiredMissing.push(id)
  }

  /* --- 当前状态：只看本章相关主体，且受时间边界约束 --- */
  const states = l.currentState.filter(
    (s) =>
      s.status === 'active' &&
      (!focus.size || focus.has(s.subjectId)) &&
      classify(s, 'states') === 'usable'
  )

  /* --- 角色认知：只看本章出场角色，且只看**当前**认知 --- */
  // R2 起认知也有演变历史（suspects → knows）：旧看法必须留在存储层可查，
  // 但绝不能同时进入上下文 —— 否则模型会同时看到「他怀疑」和「他确信」。
  const knowledge = l.characterKnowledge.filter(
    (k) =>
      (!k.status || k.status === 'active') &&
      focus.has(k.characterId) &&
      classify(k, 'knowledge') === 'usable'
  )

  /* --- 线索：本章涉及的优先，其余未了结的按章号降序排后面 --- */
  const openAll = []
  for (const t of l.plotThreads) {
    if (t.status === 'paid_off' || t.status === 'abandoned') continue
    if (classify(t, 'threads') === 'usable') openAll.push(t)
  }
  const thRelated = openAll.filter((t) => fset.has(t.foreshadowId))
  const thRest = openAll.filter((t) => !fset.has(t.foreshadowId)).sort(byChapterDesc)
  const threadOrdered = [...thRelated, ...thRest]
  const threads = threadOrdered.slice(0, maxThreads)

  /* --- 诊断：任何一次剔除都要说得出理由 --- */
  const diagnostics = {
    chapterNo: Number.isFinite(chapterNo) ? chapterNo : null,
    quarantined,
    futureSkipped,
    requiredMissing,
    truncated: {
      facts: {
        requested: factOrdered.length,
        included: facts.length,
        droppedIds: factDropped.map((f) => f.id),
      },
      threads: {
        requested: threadOrdered.length,
        included: threads.length,
        droppedIds: threadOrdered.slice(maxThreads).map((t) => t.id),
      },
    },
    // 一行摘要，便于日志与界面提示
    summary: [],
  }
  const d = diagnostics
  if (d.futureSkipped.facts + d.futureSkipped.states + d.futureSkipped.knowledge + d.futureSkipped.threads > 0) {
    d.summary.push(`已剔除 ${d.futureSkipped.facts + d.futureSkipped.states + d.futureSkipped.knowledge + d.futureSkipped.threads} 条未来章节的记录`)
  }
  const qTotal = Object.values(d.quarantined).reduce((n, a) => n + a.length, 0)
  if (qTotal > 0) d.summary.push(`已隔离 ${qTotal} 条来源不可信记录`)
  if (d.truncated.facts.droppedIds.length || d.truncated.threads.droppedIds.length) {
    d.summary.push(`超预算截断 ${d.truncated.facts.droppedIds.length + d.truncated.threads.droppedIds.length} 条`)
  }
  if (requiredMissing.length) d.summary.push(`${requiredMissing.length} 条必需记录不可用`)

  return { facts, states, knowledge, threads, diagnostics }
}

/* ------------------------------- 历史查询 ------------------------------- */

/** 某实体在某章之前已知的事实（供倒叙、历史调查、回查使用） */
export function queryFacts(project, { entityId, uptoChapter = Infinity, includeSuperseded = false } = {}) {
  const l = ensureLedger(project)
  return l.canonicalFacts.filter((f) => {
    if (!includeSuperseded && f.status !== 'active') return false
    if (entityId && !(f.entityIds || []).includes(entityId)) return false
    if (f.sourceChapter !== null && f.sourceChapter > uptoChapter) return false
    return true
  })
}

/** 某实体的状态变更轨迹 */
export function queryStateHistory(project, subjectId) {
  return ensureLedger(project).currentState.filter((s) => s.subjectId === subjectId)
}

/* ------------------------------ 从提取结果写入 ------------------------------ */

/**
 * 把「记忆提取」的输出落进账本。
 *
 * 来源可信度规则（第 2 轮评审）：**有出处即可信**。
 * 正常抽取必然带章号 → canonical；若调用方没给章号（不应发生），
 * 则标记为待复核并隔离，避免无出处的记录混进正文上下文。
 *
 * 状态与认知**不再直接追加**（R2）：统一经 state-engine 规划+原子提交，
 * 于是「新状态生效时正确收尾旧状态」「同章往返」「重复提交不重复执行」
 * 「非法转移整批不落」这几件事在抽取入口就自动成立。
 * 事实与线索仍走 appendUnique —— 它们没有「替代」语义。
 *
 * **顺序是有意的**（R2 失败保护）：先跑状态转移，转移被拒则**整批不落** ——
 * 连事实与线索也不写。若反过来先写事实，一批含非法转移的抽取就会留下
 * 「事实进了账本、状态没进」的半成品，正是「失败保护」要求禁止的情形。
 * 代价是：一次形状损坏的抽取会让本章的记忆全部推迟到重跑，这是刻意的取舍 ——
 * 记忆可以重抽，正文不会被这段逻辑改动。
 *
 * @param {object} extracted  模型输出：{ summary, facts[], states[], knowledge[], threads[], resolved[] }
 * @param {object} ctx        { chapterNo, resolveName, sourceVersion, batchKey }
 */
export function applyExtraction(project, extracted, ctx = {}) {
  const { chapterNo = null, resolveName = () => null, sourceVersion = null, batchKey = null, evidenceText = null } = ctx
  const l = ensureLedger(project)
  const result = {
    facts: 0,
    states: 0,
    knowledge: 0,
    threads: 0,
    resolved: 0,
    events: 0,
    superseded: 0,
    violations: [],
    transitionOk: true,
    rejected: false,
  }
  const trust = chapterNo === null || chapterNo === undefined ? TRUST.NEEDS_REVIEW : TRUST.CANONICAL

  // 当前状态 + 角色认知：交给状态转移引擎（规划 → 原子提交）
  const changes = [
    ...(extracted?.states || []).map((s) => ({
      kind: 'state',
      subject: s?.subject,
      attribute: s?.attribute,
      value: s?.value,
      sinceChapter: chapterNo,
      sourceSpan: s?.evidence && evidenceText?.includes(s.evidence) ? { quote: s.evidence, start: evidenceText.indexOf(s.evidence) } : null,
    })),
    ...(extracted?.knowledge || []).map((k) => ({
      kind: 'knowledge',
      character: k?.character,
      fact: k?.fact,
      belief: k?.belief,
      sinceChapter: chapterNo,
      sourceSpan: k?.evidence && evidenceText?.includes(k.evidence) ? { quote: k.evidence, start: evidenceText.indexOf(k.evidence) } : null,
    })),
  ]
  const tr = applyStateChanges(project, changes, { chapterNo, resolveName, sourceVersion, batchKey })
  result.states = tr.applied?.states || 0
  result.knowledge = tr.applied?.knowledge || 0
  result.events = tr.applied?.events || 0
  result.superseded = tr.applied?.superseded || 0
  result.transitionOk = tr.ok !== false
  result.transitionSkipped = !!tr.skipped
  result.rejected = tr.ok === false
  result.violations = tr.violations || []
  if (result.violations.length) {
    for (const v of result.violations) console.warn(`[第 ${chapterNo} 章 · 状态] ${v.code}：${v.message}`)
  }
  if (result.rejected) {
    // 整批不落：事实与线索也不写，账本保持这一批抽取之前的样子
    console.warn(`[第 ${chapterNo} 章 · 状态] 本批抽取含非法转移，已整批拒绝，账本未改动`)
    return result
  }

  // 事实
  const factEntries = (extracted?.facts || [])
    .map((raw) => {
      const text = String(typeof raw === 'object' ? raw?.text || '' : raw || '').trim()
      const evidence = String(typeof raw === 'object' ? raw?.evidence || '' : '').trim()
      if (!text) return null
      const hit = evidenceText == null ? null : (isSpecificEvidence(evidence) ? locateEvidence(evidenceText, evidence) : null)
      const located = !!hit
      return makeFact({ text, entityIds: matchNames(text, project), sourceChapter: chapterNo,
        sourceSpan: hit ? { start: hit.start, quote: hit.quote } : null, trust: evidenceText == null ? trust : located ? TRUST.CANONICAL : TRUST.NEEDS_REVIEW })
    }).filter(Boolean)
  result.facts = addFacts(project, factEntries)

  // 线索
  const threadEntries = (extracted?.threads || [])
    .map((raw) => {
      const text = String(typeof raw === 'object' ? raw?.text || '' : raw || '').trim()
      const evidence = String(typeof raw === 'object' ? raw?.evidence || '' : '').trim()
      if (!text) return null
      const hit = evidenceText == null ? null : (isSpecificEvidence(evidence) ? locateEvidence(evidenceText, evidence) : null)
      const located = !!hit
      const item = makeThread({ text, status: 'open', sourceChapter: chapterNo,
        trust: evidenceText == null ? trust : located ? TRUST.CANONICAL : TRUST.NEEDS_REVIEW })
      item.sourceSpan = hit ? { start: hit.start, quote: hit.quote } : null
      item.entityIds = matchNames(text, project)
      return item
    }).filter(Boolean)
  result.threads = addThreads(project, threadEntries)

  // 已了结
  result.resolved = resolveThreads(project, extracted?.resolved)

  return result
}

/** 文本里出现的实体名 → 实体 ID */
export function matchNames(text, project) {
  const hits = new Set()
  const t = String(text || '')
  for (const e of project.entities || []) {
    const names = [e.name, ...(e.aliases || [])].filter(Boolean)
    if (names.some((n) => t.includes(n))) hits.add(e.id)
  }
  return [...hits]
}

/**
 * 按名字（含别名、敬称、以及**姓名后缀简称**）解析实体 ID —— 供提取结果回填使用。
 *
 * 为什么需要这些：模型抽出来的主体名常常是正文里的**称呼**，而不是设定里的全名 ——
 * 「星野遥」在正文里被叫作「遥学姐」「遥」，「五十岚咲」被叫作「会长」「咲」。
 * 只认全名时这些变化会被判「无法解析到实体」（曾真实发生：
 * `状态变化的主体无法解析到实体：遥学姐`）。
 *
 * 判据是**形状化的、可解释的**，不做模糊语义猜测：
 *   1. 精确命中全名 / 别名；
 *   2. 剥掉敬称（「遥学姐」→「遥」）；
 *   3. 姓名后缀简称（「五十岚咲」→ 岚咲 / 咲；「星野遥」→ 遥），且必须在该章正文里
 *      真实出现过才认，避免把常用单字误绑到别的角色上。
 * 仍然对不上就返回 null，由上层判违规 —— 不伪造关联。
 *
 * ⚠️ **本函数不得原地修改传入的 project**（与 commitDraft 的纯函数纪律一致）。
 * 学习到的新称呼通过返回值的 `.learned` 数组交回调用方，由调用方决定是否落盘
 * （例如在 commitDraft 里写到副本上）。早期版本直接写 `e.aliases.push(...)`，
 * 结果「证据不合格而拒绝提交」的路径会把别名留在正式对象上，破坏了
 * 「拒绝时项目一字未改」的保证 —— 被两条既有测试当场抓住。
 *
 * @returns {Function & {learned: Array<{name:string, id:string}>}}
 */
export function makeNameResolver(project, { text = null } = {}) {
  const map = new Map()
  const learned = []
  const add = (key, id) => {
    const k = String(key || '').trim()
    // 先登记的不覆盖后登记的：全名/别名优先于自动推导的简称。
    if (k && !map.has(k)) map.set(k, id)
  }
  /**
   * 从全名推导可能的「称呼」，只做形状化推导：
   *   「五十岚咲」→ 咲 / 岚咲；「星野遥」→ 遥 / 野遥；单字名与超长名不推导。
   */
  const suffixOf = (name) => {
    const s = String(name || '').trim()
    if (s.length < 2 || s.length > 4) return []
    const out = [s.slice(-1)]
    if (s.length > 2) out.push(s.slice(-2))
    return out
  }
  // 先登记所有全名与显式别名，再登记「正文里真实出现过」的推导简称。
  for (const e of project.entities || []) for (const n of [e.name, ...(e.aliases || [])]) add(n, e.id)
  const body0 = text ? String(text) : null
  for (const e of project.entities || []) {
    for (const s of suffixOf(e.name)) {
      if (map.has(s)) continue
      if (body0 && !body0.includes(s)) continue
      add(s, e.id)
      learned.push({ name: s, id: e.id })
    }
  }
  if (!text) return Object.assign((name) => map.get(String(name || '').trim()) || null, { learned })
  const body = String(text)
  // 中文/日式语境里的敬称与关系后缀。模型抽出来的主体名常带着它们
  // （「遥学姐」「五十岚会长」「咲同学」），剥掉后才是名字本身。
  const HONORIFICS = ['学姐', '学长', '同学', '前辈', '老师', '先生', '小姐', '会长', '部长', '社长', '队长', '医生', '教授', '君', '酱', '桑', '氏', '様']
  const strip = (s) => {
    let out = s
    let hit = true
    while (hit) {
      hit = false
      for (const h of HONORIFICS) {
        if (out.length > h.length && out.endsWith(h)) { out = out.slice(0, -h.length); hit = true }
        if (out.length > h.length && out.startsWith(h)) { out = out.slice(h.length); hit = true }
      }
    }
    return out.trim()
  }
  const remember = (name, id) => {
    if (!learned.some((x) => x.name === name && x.id === id)) learned.push({ name, id })
    map.set(name, id)
    return id
  }
  const fn = (name) => {
    const key = String(name || '').trim()
    const hit = map.get(key)
    if (hit) return hit
    // 带敬称的称呼：剥掉后缀再找一次（「遥学姐」→「遥」）
    const bare = strip(key)
    if (bare && bare !== key) {
      const h2 = map.get(bare)
      if (h2) return remember(bare, h2)
      // 简称本身还没登记（例如首次就写「遥学姐」）→ 走后缀推导
      for (const e of project.entities || []) {
        if (suffixOf(e.name).includes(bare) && body.includes(bare)) return remember(bare, e.id)
      }
    }
    // 未登记但形状像姓名后缀、且确实出现在本章正文里 ⇒ 认作该角色并记下这个称呼
    for (const e of project.entities || []) {
      if (suffixOf(e.name).includes(bare) && body.includes(bare)) return remember(bare, e.id)
    }
    return null
  }
  return Object.assign(fn, { learned })
}

/** 把解析器学到的称呼写进项目实体（**只在调用方明确要落盘时**才用）。 */
export function applyLearnedAliases(project, learned = []) {
  let changed = false
  for (const { name, id } of learned) {
    const e = (project.entities || []).find((x) => x.id === id)
    if (!e) continue
    e.aliases ||= []
    if (!e.aliases.includes(name)) { e.aliases.push(name); changed = true }
  }
  return changed
}
