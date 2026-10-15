/**
 * R3 伏笔与披露引擎。
 *
 * 三条彼此独立的事实链：
 *  1) 计划关联 chapter.foreshadows —— 仅说明将来准备发生什么；
 *  2) 正文证据 ledger.foreshadowEvents —— 只有证据原文匹配且章节已提交才可建立；
 *  3) 披露许可 —— 显式计划、已发生前置事件、批准状态三者同时成立。
 *
 * 旧作品可以保存候选关联，但候选不享受计划授权，不改变伏笔状态。
 */
import crypto from 'node:crypto'
import { foreshadowId, makeThread, TRUST } from './schema.js'
import { locateEvidence, isSpecificEvidence } from './ledger.js'

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 18)
const ACTIONS = new Set(['plant', 'reinforce', 'pay_off'])
/**
 * 角色真相披露的证据门槛**有意比一般证据更严**（上限不是「统一」而是「具名 + 说清理由」）。
 *
 * 一般证据走 `ledger.isSpecificEvidence`（去标点后实义字 ≥2）；而这里一旦被接受，
 * `readerKnown` 就会认为「读者已经知道这个秘密」，后续章节的 `findLeaks` 会把它当成
 * **已授权内容** ⇒ 一条误判会让这个秘密在之后随便泄漏。所以保留更长的门槛，
 * 但用具名常量取代散落的字面量。
 */
const MIN_EVIDENCE_REVEAL = 8
const done = (event) => event?.status === 'accepted' && event?.trust === TRUST.CANONICAL
const chapterNum = (n) => Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : null

export function chapterPlans(project) {
  return (project.outline?.volumes || []).flatMap((v) => v.chapters || [])
}
export function getForeshadow(project, id) {
  return (project.outline?.foreshadows || []).find((f) => f.id === id)
}
export function ensureForeshadowStore(project) {
  project.ledger ||= {}
  project.ledger.foreshadowEvents ||= []
  return project.ledger.foreshadowEvents
}

/**
 * 「作者是否已授权这条伏笔被回收」——**唯一判据**，别在别处再写一遍。
 *
 * 两个来源，满足其一即可：
 *  ① 章计划里该动作被批准（新大纲的显式计划，或 `importLinkProposals` 的人工审核）；
 *  ② 伏笔级 `safeReveal`（界面唯一入口：「创作资料与编辑 → 伏笔 → 回收披露授权」）。
 *
 * 为什么必须有②：授权是**作者意图**，属于伏笔本身，不该只挂在某一版章计划上——
 * 否则一次 `mode:'full'` 重排（`replan.js` 对 pay_off 一律写 `approved:false`）就会把
 * 作者的批准悄悄抹掉。②只放宽「谁批准了」，其余客观门禁（章号、前置事件、已铺设、
 * 关联状态）一条都不放宽；模型侧依旧 `approved:false`，没有自我授权的能力。
 *
 * ⛔ 真实事故（2026-10-13 审计）：这个判据一度**只在 `revealDecision()` 里**实现，
 *    而 `workflow.js` 的抽取允许清单另按 `action.approved` 判了一次 ⇒ 作者授权之后
 *    **正文写得出来、但回收事件永远不入账**（3 本真实作品 50 章，`pay_off` 事件数 = 0）
 *    ⇒ 生命周期停在 reinforced、`doneForeshadows` 恒空、`readerKnown` 拿不到已授权文本。
 *    ⇒ 判据只留这一处实现。
 */
export function isRevealAuthorized(foreshadow) {
  return foreshadow?.safeReveal?.approved === true
    && typeof foreshadow.safeReveal.text === 'string'
    && foreshadow.safeReveal.text.trim().length > 0
}

/**
 * 第 N 章**允许抽取模型输出的伏笔动作**（抽取提示词的允许清单）。
 * 判据与 `revealDecision()` 共用 `isRevealAuthorized`，避免两处漂移。
 */
export function allowedForeshadowActions(project, chapterNo) {
  const meta = chapterPlans(project).find((c) => Number(c.no) === Number(chapterNo))
  return (meta?.foreshadows || [])
    .filter((a) => a.action !== 'pay_off'
      || a.approved === true
      || isRevealAuthorized(getForeshadow(project, a.id)))
    .map((a) => ({ id: a.id, action: a.action }))
}

/** 升级旧数据的字段结构；不认可任何推断出来的计划关联。 */
export function normalizeForeshadows(project) {
  let changed = false
  for (const f of project.outline?.foreshadows || []) {
    if (!f.id) { f.id = foreshadowId(f.seed); changed = true }
    if (!Array.isArray(f.prerequisiteEventIds)) { f.prerequisiteEventIds = []; changed = true }
    if (!f.linkStatus) { f.linkStatus = 'needsReview'; changed = true }
    if (!f.lifecycle) { f.lifecycle = 'approved'; changed = true }
    // 旧版命名 plantAt/revealAt，统一将其只作为计划坐标，不反写实际事件。
    if (f.plantChapter === undefined) { f.plantChapter = chapterNum(f.plantAt); changed = true }
    if (f.payoffChapter === undefined) { f.payoffChapter = chapterNum(f.revealAt); changed = true }
  }
  if (!Array.isArray(project.ledger?.foreshadowEvents)) { ensureForeshadowStore(project); changed = true }
  return changed
}

/**
 * 对旧数据只提出候选，不将文本近似识别误报为事实。
 * 标准是字面分词交集，刻意不用它作为正式授权。
 */
export function suggestLegacyLinks(project, topN = 3) {
  const plans = chapterPlans(project)
  const tokens = (s) => {
    const raw = String(s || '').replace(/[\p{P}\p{S}\s]/gu, '')
    const out = new Set()
    for (let i = 0; i + 1 < raw.length; i++) out.add(raw.slice(i, i + 2))
    return out
  }
  const similarity = (a, b) => {
    const at = tokens(a), bt = tokens(b)
    if (!at.size || !bt.size) return 0
    let hits = 0
    for (const t of at) if (bt.has(t)) hits++
    return Number((hits / Math.sqrt(at.size * bt.size)).toFixed(3))
  }
  return (project.outline?.foreshadows || []).map((f) => {
    const rank = (sample) => plans.map((c) => ({ chapterNo: c.no, score: similarity(sample, [c.title, c.summary, c.goal].join(' ')) }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topN)
    return { foreshadowId: f.id, seed: f.seed, plantCandidates: rank(f.seed), payoffCandidates: rank(f.payoff), status: 'needsReview' }
  })
}

/**
 * 导入 LLM/人工提出的旧作品计划关联。
 * 默认只存候选：模型判断不能自行升级权限；reviewed=true 表示调用方做过明确审核。
 */
export function importLinkProposals(project, proposals, { reviewed = false, reviewer = null } = {}) {
  const plans = new Map(chapterPlans(project).map((c) => [c.no, c]))
  const out = []
  for (const proposal of proposals || []) {
    const f = getForeshadow(project, proposal.foreshadowId)
    const plant = chapterNum(proposal.plantChapter)
    const payoff = chapterNum(proposal.payoffChapter)
    if (!f || (plant && !plans.has(plant)) || (payoff && !plans.has(payoff)) || (plant && payoff && plant > payoff)) {
      out.push({ id: proposal.foreshadowId, ok: false, reason: 'invalid-reference' }); continue
    }
    // proposal 不含可校验的出处、信心标记时保持 needsReview。
    const accepted = reviewed === true && !!reviewer && !!proposal.evidence && (plant || payoff)
    f.linkProposal = { plantChapter: plant, payoffChapter: payoff, evidence: String(proposal.evidence || ''),
      confidence: proposal.confidence ?? null, status: accepted ? 'reviewed' : 'needsReview', reviewer: accepted ? reviewer : null }
    f.linkStatus = accepted ? 'explicit' : 'needsReview'
    if (accepted) {
      f.plantChapter = plant; f.payoffChapter = payoff
      for (const [no, action] of [[plant, 'plant'], [payoff, 'pay_off']]) {
        if (!no) continue
        const c = plans.get(no)
        c.foreshadows ||= []
        if (!c.foreshadows.some((a) => a.id === f.id && a.action === action)) {
          c.foreshadows.push({ id: f.id, action, approved: true, approvalSource: `review:${reviewer}` })
        }
      }
    }
    out.push({ id: f.id, ok: true, status: f.linkStatus })
  }
  return out
}

/** 确保事件前置条件是真实已提交的事件，而不是未来计划或提取候选。 */
function prerequisitesMet(project, ids) {
  const events = [...(project.ledger?.foreshadowEvents || []), ...(project.ledger?.stateEvents || [])]
  return (ids || []).every((id) => events.some((e) => e.id === id && (done(e) || (e.kind && e.trust === TRUST.CANONICAL && e.sourceVersion != null))))
}

/**
 * 若章节没有明确授权，或曾经的铺设事件尚未正式记录，均不释放 payoff。
 * 新生成大纲的显式计划可以以 auto-planner 授权；旧迁移候选不可自动授权。
 */
export function revealDecision(project, meta, foreshadow) {
  const action = (meta?.foreshadows || []).find((a) => a.id === foreshadow?.id && a.action === 'pay_off')
  if (!action) return { allowed: false, reason: 'no-explicit-action' }
  /**
   * 授权有两个来源，满足其一即可：
   *  ① 章计划里该动作被批准（新大纲的显式计划，或 `importLinkProposals` 的人工审核）；
   *  ② 作者对这条伏笔做过**回收披露授权**（`foreshadow.safeReveal`；界面唯一入口是
   *     「创作资料与编辑 → 伏笔 → 回收披露授权」）。
   *
   * 为什么必须有②：授权是**作者意图**，属于伏笔本身，不该只挂在某一版章计划上——
   * 否则一次 `mode:'full'` 重排（`replan.js` 对 pay_off 一律写 `approved:false`）就会把
   * 作者的批准悄悄抹掉。②只放宽「谁批准了」，其余客观门禁（章号、前置事件、已铺设、
   * 关联状态）一条都不放宽；模型侧依旧 `approved:false`，没有自我授权的能力。
   */
  if (!action.approved && !isRevealAuthorized(foreshadow)) return { allowed: false, reason: 'not-approved' }
  if (foreshadow.linkStatus === 'needsReview') return { allowed: false, reason: 'unreviewed-link' }
  if (chapterNum(foreshadow.payoffChapter ?? foreshadow.revealAt) !== meta.no) return { allowed: false, reason: 'wrong-chapter' }
  if (!prerequisitesMet(project, [...(foreshadow.prerequisiteEventIds || []), ...(action.prerequisiteEventIds || [])])) {
    return { allowed: false, reason: 'missing-prerequisite' }
  }
  const planted = (project.ledger?.foreshadowEvents || []).some((e) =>
    e.foreshadowId === foreshadow.id && e.chapterNo < meta.no && ['plant', 'reinforce'].includes(e.action) && done(e))
  if (!planted) return { allowed: false, reason: 'not-planted' }
  return { allowed: true, reason: 'authorized' }
}

/**
 * 正文是否确有线索：只接受 evidence 与正文中的逐字一致片段，并验证来源章节。
 * 这是保守的确定性检查；语义上等价但文字不同，保留待审核，绝不伪造已铺设。
 */
export function recordForeshadowEvidence(project, chapter, proposals = [], opts = {}) {
  const events = ensureForeshadowStore(project)
  const plan = chapterPlans(project).find((c) => c.no === chapter?.no)
  const report = { accepted: [], rejected: [] }
  if (!plan || !chapter?.text || chapter.status !== 'committed' || opts.extractOk === false) {
    return { ...report, rejected: [{ reason: 'uncommitted-or-empty-chapter' }] }
  }
  const sourceVersion = opts.sourceVersion ?? chapter.sourceVersion ?? project.headVersion
  for (const proposal of proposals) {
    const f = getForeshadow(project, proposal.foreshadowId)
    const action = String(proposal.action || '')
    const evidence = String(proposal.evidence || '').trim()
    const planned = (plan.foreshadows || []).some((a) => a.id === f?.id && a.action === action)
    // 逐字定位正文证据（容忍模型自套的外层引号；详见 ledger.locateEvidence）
    const hit = evidence ? locateEvidence(chapter.text, evidence) : null
    const offset = hit ? hit.start : -1
    // ⛔ 证据门槛统一到 `ledger.isSpecificEvidence`（去掉空白标点后实义字 ≥2）。
    //    这里曾经是 `evidence.length < 4`（**原始字符长度**）—— 与 ledger 当年的 `>=4 字`
    //    是同一个病：中文里 `"不是。"` 只有 3 个字符，会被直接拒掉，而它逐字就在正文里、
    //    是完全有效的证据。不一致的代价很重：拒掉一条**铺设**证据 ⇒ 账本没有 plant 事件
    //    ⇒ 回收章判 `not-planted` ⇒ **那一章永久写不出来**。
    if (!f || !ACTIONS.has(action) || !planned || offset < 0 || !isSpecificEvidence(evidence)) {
      report.rejected.push({ foreshadowId: proposal.foreshadowId, reason: 'missing-plan-or-evidence' }); continue
    }
    if (action === 'pay_off' && !revealDecision(project, plan, f).allowed) {
      report.rejected.push({ foreshadowId: f.id, reason: 'reveal-not-authorized' }); continue
    }
    // sourceSpan 记录**正文里实际匹配到的片段**（不是模型给的带引号版本），
    // 保证 span 能落回正文、可被阅读页精确定位。
    const quote = hit.quote
    const id = `fe_${sha([project.id, sourceVersion, chapter.no, f.id, action, offset, quote].join('|'))}`
    if (events.some((e) => e.id === id)) continue
    const event = { id, foreshadowId: f.id, action, chapterNo: chapter.no, sourceVersion,
      sourceSpan: { start: offset, end: offset + quote.length, quote },
      status: 'accepted', trust: TRUST.CANONICAL }
    events.push(event)
    // 伏笔的状态依据真正的证据事件汇总；计划不会直接影响状态。
    f.lifecycle = action === 'pay_off' ? 'paid_off' : action === 'reinforce' ? 'reinforced' : 'planted'
    // ⛔ 真实事故（2026-10-13 审计）：`thread.foreshadowId` 在**全项目都没有写入方**
    //    （`makeThread` 支持该字段，但没有任何调用方传它）⇒ 这个 find 恒为 undefined
    //    ⇒ 伏笔的铺设/回收**永远不反映到线索账本**，「已完成清单」只剩模型自报的 `resolved`
    //    （实测 3 本书 50 章：pay_off 事件 0 条、线索全 open）。
    //    修法：按这条伏笔找到/建一条线索并回填外键，让两本账真正连起来。
    project.ledger ||= {}
    project.ledger.plotThreads ||= []
    const seedText = String(f.seed || '').trim().slice(0, 120) || `伏笔 ${f.id}`
    const candidate = makeThread({
      text: seedText, foreshadowId: f.id, status: 'open',
      sourceChapter: Number(f.plantChapter ?? f.plantAt) || chapter.no,
    })
    let thread = project.ledger.plotThreads.find((t) => t.foreshadowId === f.id && t.trust === TRUST.CANONICAL)
      // 抽取侧可能已经为同一句线索建过 thread（id 由文本派生）⇒ 复用它并回填外键，
      // 不要造出两条同 id 的记录。
      || project.ledger.plotThreads.find((t) => t.id === candidate.id && !t.foreshadowId)
    if (thread) thread.foreshadowId = f.id
    else { thread = candidate; project.ledger.plotThreads.push(thread) }
    thread.status = f.lifecycle
    if (action === 'pay_off') thread.paidOffAt = chapter.no
    if (action === 'plant') thread.plantedAt = chapter.no
    report.accepted.push(event)
  }
  return report
}

/** 给下游模型/人工校对的一次性输入，不在本机自行推测结果为真。 */
export function makeLinkAssistantPacket(project) {
  return { instruction: '为每条伏笔提议铺设章和回收章。只输出候选 JSON，不要将计划当作已发生事实。不能确定时填 null。',
    foreshadows: (project.outline?.foreshadows || []).map(({ id, seed, payoff }) => ({ id, seed, payoff })),
    chapters: chapterPlans(project).map(({ no, title, summary, goal }) => ({ no, title, summary, goal })) }
}

/**
 * R3 角色秘密的“读者已得知”事件：与角色本人的知识事件分离。
 * 即使读者知道某真相，也不能自动写入任意角色的 CharacterKnowledge。
 */
export function recordEntityRevealEvidence(project, chapter, proposals = [], { sourceVersion = null } = {}) {
  const events = ensureForeshadowStore(project)
  const meta = chapterPlans(project).find((c) => c.no === chapter?.no)
  const result = { accepted: [], rejected: [] }
  if (!meta || chapter.status !== 'committed' || !chapter.text) return { ...result, rejected: [{ reason: 'uncommitted-chapter' }] }
  for (const p of proposals) {
    const directive = (meta.reveals || []).find((r) => r.entityId === p.entityId && r.projectionId === p.projectionId && r.approved === true)
    const entity = (project.entities || []).find((e) => e.id === p.entityId)
    const projection = (entity?.revealProjections || []).find((r) => r.id === p.projectionId && r.approved === true)
    const evidence = String(p.evidence || '').trim()
    // 同样容忍外层引号（详见 ledger.locateEvidence）
    const hit = evidence ? locateEvidence(chapter.text, evidence) : null
    const offset = hit ? hit.start : -1
    if (!directive || !projection || evidence.length < MIN_EVIDENCE_REVEAL || offset < 0 || !prerequisitesMet(project,
      [...(directive.prerequisiteEventIds || []), ...(projection.prerequisiteEventIds || [])])) {
      result.rejected.push({ entityId: p.entityId, reason: 'missing-approval-prerequisite-or-evidence' }); continue
    }
    const quote = hit.quote
    const id = `re_${sha([project.id, chapter.no, sourceVersion, p.entityId, p.projectionId, offset, quote].join('|'))}`
    if (events.some((e) => e.id === id)) continue
    const event = { id, kind: 'entity_reveal', entityId: p.entityId, projectionId: p.projectionId,
      chapterNo: chapter.no, sourceVersion, sourceSpan: { start: offset, end: offset + quote.length, quote },
      status: 'accepted', trust: TRUST.CANONICAL }
    events.push(event)
    result.accepted.push(event)
  }
  return result
}

/** 已确认的历史披露：后续章节可读；不改变未见证该事件的角色认知。 */
export function readerKnownProjections(project, chapterNo) {
  const results = []
  const seen = new Set()
  for (const e of project.ledger?.foreshadowEvents || []) {
    if (!done(e) || e.chapterNo >= chapterNo) continue
    let text = null
    if (e.kind === 'entity_reveal') {
      const character = (project.entities || []).find((x) => x.id === e.entityId)
      const projection = (character?.revealProjections || []).find((p) => p.id === e.projectionId && p.approved)
      text = projection?.safeText || null
    } else if (e.action === 'pay_off') {
      const foreshadow = getForeshadow(project, e.foreshadowId)
      text = foreshadow?.safeReveal?.approved ? foreshadow.safeReveal.text : null
    }
    if (text && !seen.has(text)) { results.push(text); seen.add(text) }
  }
  return results
}
