/**
 * 状态转移引擎（R2）
 *
 * 为什么必须是一个**独立模块**，而不是往 ledger.js 里再加两个函数：
 *
 *   ledger.js 回答的是「账本里有什么」；本模块回答的是「一次变化该不该发生、
 *   发生了之后旧状态怎么办」。把后者独立出来，才能做到：
 *     · 先算全批，再决定是否落库 —— 整批合法才提交，非法则**一条都不落**；
 *     · 状态记录、事件、幂等键三者的派生互相独立，不靠改哈希内容救场；
 *     · 历史查询（某章有效状态、某角色的认知演变）有唯一入口。
 *
 * 三个 ID 各司其职（R2 硬约束，详见 schema.js）：
 *   state_id        记录内容      「当前是什么」
 *   event_id        一次转移      「发生了什么」
 *   idempotency_key 提交来源      「这次提交是不是重复」
 * 因此「同章内两次内容相同的变化」与「同一批被重复提交」可以同时成立。
 *
 * 与 R4 的边界（评审明确要求，不得越界）：
 *   本模块只提供**机制**，不提供**授权**。它不知道正文是否已被作者确认 ——
 *   `applyStateChanges` 会不会被调用、以什么 batchKey 调用，由上层决定。
 *   正式提交机制（草稿隔离、版本校验、写锁、失败恢复）属 R4，本模块预留 batchKey
 *   与 sourceVersion 两个接入点，等 R4 把稳定提交标识传进来即可，无需改动本文件。
 */
import {
  TRUST,
  emptyLedger,
  makeState,
  makeKnowledge,
  makeStateEvent,
  opIdempotencyKey,
  batchFingerprint,
  normalizeText,
} from './schema.js'

/* ------------------------------- 常量与工具 ------------------------------- */

const BELIEFS = new Set(['knows', 'believes', 'suspects'])

/**
 * 违规类型。**severity 决定后果**，不是标注：
 *   error   → 整批拒绝，账本一字不改（失败保护）
 *   warning → 该条跳过，其余照常（模型噪声不该拖垮整章）
 *
 * ⚠️ 分级的唯一判据是「这条坏数据会不会污染**别处**」：
 *   · UNSUPPORTED_KIND / TIME_REGRESSION —— 会让账本流出形状错误的数据，
 *     或让时间线前后颠倒污染所有后续比较 ⇒ 必须 error。
 *   · 其余（主体解析不到 / 提取残缺 / 认知取值非法）—— **只坏这一条**，
 *     跳过它其余记录完全正常 ⇒ 一律 warning。
 *
 * 真实踩坑（v2.0.0 上线后）：`MISSING_FIELD` 曾是 error。模型从正文里提取出
 * 「部室柜子发生了变化」但没给属性名（柜子本来就没属性可填），于是**整章作废**。
 * 结果是：那章正文 2353 字已经生成、钱已经花了、草稿躺在 run 里，
 * 却永远提交不进去，还把**整个作品**锁死（见 workflow.createRun 的并行保护）。
 * 主人的原则（原话）：「不放行浪费 token 还不给看也太变态了」。
 * ⇒ 提取残缺只跳这一条，正文照常提交，并把跳过的条目记进 unresolvedSubjects 让作者看得见。
 */
export const VIOLATION = {
  UNSUPPORTED_KIND: { code: 'unsupported-kind', severity: 'error' },
  UNKNOWN_SUBJECT: { code: 'unknown-subject', severity: 'warning' },
  MISSING_FIELD: { code: 'missing-field', severity: 'warning' },
  INVALID_BELIEF: { code: 'invalid-belief', severity: 'warning' },
  TIME_REGRESSION: { code: 'time-regression', severity: 'error' },
}

/**
 * 章号归一化。
 * 注意 `Number(null) === 0` —— 必须先把「无章号」拦下来，
 * 否则 null 会被当成第 0 章，一路污染时间比较（踩过）。
 */
const chOf = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 该记录在 chapterNo 这一章是否**有效**：已生效且尚未被替代 */
export function isEffectiveAt(rec, chapterNo) {
  const ch = chOf(chapterNo)
  const since = chOf(rec?.sinceChapter)
  if (ch !== null && since !== null && since > ch) return false
  const until = chOf(rec?.untilChapter)
  // untilChapter = 被替代的章号 ⇒ 该章起新状态接管，旧状态从此不再有效
  if (ch !== null && until !== null && until <= ch) return false
  return true
}

/** 状态按 (主体, 属性) 归并；认知按 (角色, 内容) 归并 —— 认知演变是同一件事的看法升级 */
function activeKeyOf(rec) {
  if (rec?.characterId !== undefined && rec?.fact !== undefined) {
    return `k|${rec.characterId}|${normalizeText(rec.fact)}`
  }
  return `s|${rec?.subjectId}|${rec?.attribute}`
}

const byChapterAsc = (a, b) => {
  const ca = chOf(a.sinceChapter) ?? -1
  const cb = chOf(b.sinceChapter) ?? -1
  if (ca !== cb) return ca - cb
  return (a.eventSeq || 0) - (b.eventSeq || 0)
}

/* ------------------------------ 变更归一化 ------------------------------ */

/**
 * 把「模型抽取出来的一条变化」或「调用方直接给的一条变化」统一成内部形状。
 * 只做形状归一与字段裁剪，**不做合法性判断**（判断在 planStateChanges 里）。
 */
function normalizeChange(raw, i, ctx, resolveName) {
  const kind = raw?.kind || (raw?.fact !== undefined || raw?.character !== undefined ? 'knowledge' : 'state')
  const chapterNo = chOf(raw?.sinceChapter) ?? chOf(ctx.chapterNo)
  const base = {
    index: i,
    kind,
    chapterNo,
    sourceChapter: chOf(raw?.sourceChapter) ?? chapterNo,
    sourceVersion: raw?.sourceVersion ?? ctx.sourceVersion ?? null,
    sourceSpan: raw?.sourceSpan ?? null,
    storyTime: raw?.storyTime ?? null,
    trust: raw?.trust ?? (chapterNo === null ? TRUST.NEEDS_REVIEW : TRUST.CANONICAL),
  }

  if (kind === 'knowledge') {
    const named = raw?.characterId ?? raw?.character ?? raw?.subjectId ?? raw?.subject
    return {
      ...base,
      characterId: raw?.characterId ?? resolveName(named),
      rawSubject: named,
      fact: String(raw?.fact ?? '').trim(),
      belief: raw?.belief,
    }
  }
  const named = raw?.subjectId ?? raw?.subject ?? raw?.character
  return {
    ...base,
    subjectId: raw?.subjectId ?? resolveName(named),
    rawSubject: named,
    attribute: String(raw?.attribute ?? '').trim(),
    value: String(raw?.value ?? '').trim(),
  }
}

/* -------------------------------- 规划 -------------------------------- */

/**
 * 纯粹地算一遍：这批变化会带来哪些新记录、哪些旧记录要被替代、产生哪些事件。
 *
 * **零副作用** —— 不碰 project，不改账本。任何一条 error 级违规都会让整批计划作废。
 *
 * @param {object} project
 * @param {Array} changes  变更列表（可含 state / knowledge 两种 kind）
 * @param {object} ctx     { chapterNo, sourceVersion, batchKey, resolveName }
 * @returns {object} plan   供 commitStatePlan 消费；plan.ok === false 时不得提交
 */
export function planStateChanges(project, changes = [], ctx = {}) {
  const resolveName = typeof ctx.resolveName === 'function' ? ctx.resolveName : () => null
  const chapterNo = chOf(ctx.chapterNo)
  const ledger = project?.ledger || {}
  const entities = new Set((project?.entities || []).map((e) => e.id))

  const violations = []
  const changeList = (changes || []).map((c, i) => normalizeChange(c, i, ctx, resolveName))

  // 变更提交标识：调用方给出就用它（R4 会传稳定提交号），否则退回按内容取指纹。
  // 这一条决定了「重复提交不重复执行」是**按提交**判定的，而不是按内容 ——
  // 内容相同但在同一章确实发生了两次的变化，靠 seq 区分（见下）。
  const batchKey = ctx.batchKey || batchFingerprint(changeList, chapterNo)
  const fingerprint = batchFingerprint(changeList, chapterNo)

  /* --- 1. 逐条做前置条件检查 --- */
  const accepted = []
  for (const c of changeList) {
    if (c.kind !== 'state' && c.kind !== 'knowledge') {
      violations.push({ ...VIOLATION.UNSUPPORTED_KIND, index: c.index, message: `未知的变更类型：${c.kind}` })
      continue
    }
    if (c.kind === 'state') {
      if (!c.attribute || !c.value) {
        violations.push({
          ...VIOLATION.MISSING_FIELD,
          index: c.index,
          message: `状态变化缺少属性或取值（subject=${c.rawSubject ?? c.subjectId ?? '?'}）`,
        })
        continue
      }
      if (!c.subjectId || !entities.has(c.subjectId)) {
        violations.push({
          ...VIOLATION.UNKNOWN_SUBJECT,
          index: c.index,
          message: `状态变化的主体无法解析到实体：${c.rawSubject ?? c.subjectId ?? '(空)'}`,
        })
        continue
      }
    } else {
      if (!c.fact) {
        violations.push({ ...VIOLATION.MISSING_FIELD, index: c.index, message: '认知变化缺少内容（fact）' })
        continue
      }
      if (!c.characterId || !entities.has(c.characterId)) {
        violations.push({
          ...VIOLATION.UNKNOWN_SUBJECT,
          index: c.index,
          message: `认知变化的角色无法解析到实体：${c.rawSubject ?? '(空)'}`,
        })
        continue
      }
      if (c.belief !== undefined && c.belief !== null && !BELIEFS.has(c.belief)) {
        violations.push({
          ...VIOLATION.INVALID_BELIEF,
          index: c.index,
          message: `非法的认知取值：${c.belief}（应为 knows / believes / suspects）`,
        })
        continue
      }
    }
    accepted.push(c)
  }

  /* --- 2. 时间单调性：不得用转移引擎改写已发生的过去 --- */
  // 建立「当前有效记录」索引。同一 (主体,属性) 若有多条 active（旧数据遗留），
  // 以章号最晚的一条为准，其余一并作为被替代对象清理。
  const working = new Map() // activeKey → [records...]
  for (const s of ledger.currentState || []) {
    if (s?.status && s.status !== 'active') continue
    const k = activeKeyOf(s)
    if (!working.has(k)) working.set(k, [])
    working.get(k).push(s)
  }
  for (const k of ledger.characterKnowledge || []) {
    if (k?.status && k.status !== 'active') continue
    const key = activeKeyOf(k)
    if (!working.has(key)) working.set(key, [])
    working.get(key).push(k)
  }

  const supersedeStates = new Map() // id → { id, untilChapter, supersededBy }
  const supersedeKnowledge = new Map()
  const newStates = []
  const newKnowledge = []
  const newEvents = []
  const seqByKey = new Map() // `${subjectId}|${attribute}|${chapter}` → 下一个序号

  // 已落库的同章同类事件数，作为序号起点 —— 保证不同批提交在同一章也不撞 ID
  const seedSeq = (key) => {
    let n = 0
    for (const e of ledger.stateEvents || []) {
      if (e?.seqKey === key && chOf(e.chapterNo) === chapterNo) n++
    }
    return n
  }

  for (const c of accepted) {
    const supersedeBag = c.kind === 'state' ? supersedeStates : supersedeKnowledge
    const activeList = working.get(activeKeyOf(c)) || []

    // 时间单调性：新值必须发生在当前有效值之后（同章不算倒退，支撑同章往返）
    let latest = null
    for (const r of activeList) {
      const rs = chOf(r.sinceChapter)
      if (rs === null) continue
      if (!latest || rs > chOf(latest.sinceChapter)) latest = r
    }
    if (latest && c.chapterNo !== null) {
      const ls = chOf(latest.sinceChapter)
      if (ls !== null && c.chapterNo < ls) {
        violations.push({
          ...VIOLATION.TIME_REGRESSION,
          index: c.index,
          message: `状态时间倒退：第 ${c.chapterNo} 章的新状态早于第 ${ls} 章的既有状态（${latest.value ?? latest.fact}）`,
        })
        continue
      }
    }

    const seqKey =
      c.kind === 'state' ? `${c.subjectId}|${c.attribute}|${c.chapterNo}` : `${c.characterId}|belief|${c.chapterNo}`
    if (!seqByKey.has(seqKey)) seqByKey.set(seqKey, seedSeq(seqKey))
    const seq = seqByKey.get(seqKey)
    seqByKey.set(seqKey, seq + 1)

    const fromValue =
      latest === null
        ? null
        : c.kind === 'state'
          ? latest.value
          : latest.belief

    if (c.kind === 'state') {
      const rec = makeState({
        subjectId: c.subjectId,
        attribute: c.attribute,
        value: c.value,
        sinceChapter: c.chapterNo,
        eventSeq: seq,
        sourceChapter: c.sourceChapter,
        sourceVersion: c.sourceVersion,
        sourceSpan: c.sourceSpan,
        trust: c.trust,
        storyTime: c.storyTime,
      })
      const ev = makeStateEvent({
        kind: 'state',
        subjectId: c.subjectId,
        attribute: c.attribute,
        fromValue,
        toValue: c.value,
        fromStateId: latest?.id ?? null,
        toStateId: rec.id,
        chapterNo: c.chapterNo,
        seq,
        idempotencyKey: opIdempotencyKey({
          chapterNo: c.chapterNo,
          batchKey,
          kind: 'state',
          parts: [c.subjectId, c.attribute, c.value, c.index],
        }),
        batchKey,
        seqKey,
        trust: c.trust,
        sourceChapter: c.sourceChapter,
        sourceVersion: c.sourceVersion,
        sourceSpan: c.sourceSpan,
      })
      rec.eventId = ev.id
      newStates.push(rec)
      newEvents.push(ev)
    } else {
      const belief = BELIEFS.has(c.belief) ? c.belief : 'knows'
      const rec = makeKnowledge({
        characterId: c.characterId,
        fact: c.fact,
        belief,
        sinceChapter: c.chapterNo,
        eventSeq: seq,
        sourceChapter: c.sourceChapter,
        sourceVersion: c.sourceVersion,
        sourceSpan: c.sourceSpan,
        trust: c.trust,
        storyTime: c.storyTime,
      })
      const ev = makeStateEvent({
        kind: 'knowledge',
        subjectId: c.characterId,
        attribute: 'belief',
        fromValue,
        toValue: belief,
        fromStateId: latest?.id ?? null,
        toStateId: rec.id,
        chapterNo: c.chapterNo,
        seq,
        idempotencyKey: opIdempotencyKey({
          chapterNo: c.chapterNo,
          batchKey,
          kind: 'knowledge',
          parts: [c.characterId, c.fact, belief, c.index],
        }),
        batchKey,
        seqKey,
        trust: c.trust,
        sourceChapter: c.sourceChapter,
        sourceVersion: c.sourceVersion,
        sourceSpan: c.sourceSpan,
      })
      rec.eventId = ev.id
      newKnowledge.push(rec)
      newEvents.push(ev)
    }

    // 新记录落定后，同键的旧 active 记录全部转入被替代
    for (const r of activeList) {
      if (supersedeBag.has(r.id)) continue
      supersedeBag.set(r.id, {
        id: r.id,
        untilChapter: c.chapterNo,
        supersededBy: c.kind === 'state' ? newStates[newStates.length - 1].id : newKnowledge[newKnowledge.length - 1].id,
      })
    }
    // 更新工作视图，支撑同章链式转移（A→B→A）
    working.set(activeKeyOf(c), [c.kind === 'state' ? newStates[newStates.length - 1] : newKnowledge[newKnowledge.length - 1]])
  }

  const errors = violations.filter((v) => v.severity === 'error')

  // 重复提交：同一提交标识（batchKey）已经落过账 ⇒ 整批跳过，不重复执行
  const duplicate = (ledger.stateEvents || []).some((e) => e?.batchKey === batchKey)

  return {
    ok: errors.length === 0,
    chapterNo,
    batchKey,
    fingerprint,
    duplicate,
    // ok === false 时以下一律为空 —— 这就是「整组不得部分生效」的实现方式
    changes: errors.length === 0 ? accepted : [],
    newStates: errors.length === 0 ? newStates : [],
    newKnowledge: errors.length === 0 ? newKnowledge : [],
    newEvents: errors.length === 0 ? newEvents : [],
    supersedeStates: errors.length === 0 ? [...supersedeStates.values()] : [],
    supersedeKnowledge: errors.length === 0 ? [...supersedeKnowledge.values()] : [],
    violations: errors.length === 0 ? violations.filter((v) => v.severity !== 'error') : violations,
    warnings: violations.filter((v) => v.severity === 'warning'),
    summary: {
      accepted: errors.length === 0 ? accepted.length : 0,
      rejected: changeList.length - accepted.length,
      states: errors.length === 0 ? newStates.length : 0,
      knowledge: errors.length === 0 ? newKnowledge.length : 0,
      events: errors.length === 0 ? newEvents.length : 0,
      superseded: errors.length === 0 ? supersedeStates.size + supersedeKnowledge.size : 0,
    },
  }
}

/* -------------------------------- 提交 -------------------------------- */

/**
 * 原子提交：要么整批生效，要么账本一字不改。
 *
 * 原子性的实现方式是**先算完再赋值**：所有新数组都在局部变量里构造完毕，
 * 直到最后一步才整体写回 project.ledger。中途任何异常都不会留下半成品。
 * 这是单线程 Node 下足以成立的原子性，不依赖事务与锁。
 */
export function commitStatePlan(project, plan) {
  if (!plan) return { ok: false, violations: [], warnings: [], applied: emptyApplied() }
  if (!plan.ok) {
    return { ok: false, violations: plan.violations, warnings: plan.warnings || [], applied: emptyApplied(), rejected: true }
  }
  if (plan.duplicate) {
    return {
      ok: true,
      skipped: true,
      reason: 'duplicate-batch',
      batchKey: plan.batchKey,
      violations: plan.violations || [],
      warnings: plan.warnings || [],
      applied: emptyApplied(),
    }
  }
  if (!plan.newEvents.length) {
    return {
      ok: true,
      skipped: true,
      reason: 'no-op',
      batchKey: plan.batchKey,
      violations: plan.violations || [],
      warnings: plan.warnings || [],
      applied: emptyApplied(),
    }
  }

  const l = project.ledger
  if (!l) throw new Error('commitStatePlan: 账本未初始化')

  // ---- 全部在副本上完成，最后一次性写回 ----
  const states = (l.currentState || []).map((s) => ({ ...s }))
  const knowledge = (l.characterKnowledge || []).map((k) => ({ ...k }))
  const events = l.stateEvents || []

  // 按 id 去重追加：即便上层漏判了幂等，也不会产生重复记录
  const seenS = new Set(states.map((x) => x.id))
  for (const s of plan.newStates) {
    if (seenS.has(s.id)) continue
    seenS.add(s.id)
    states.push(s)
  }
  const seenK = new Set(knowledge.map((x) => x.id))
  for (const k of plan.newKnowledge) {
    if (seenK.has(k.id)) continue
    seenK.add(k.id)
    knowledge.push(k)
  }

  // 收尾必须在**新记录入列之后**做：同章链式转移（A→B→A）里，
  // 被替代的可能是本批刚生成的记录，而它此前还不在账本里。
  const supersede = (arr, items) => {
    for (const u of items) {
      const hit = arr.find((x) => x.id === u.id)
      if (!hit) continue
      hit.status = 'superseded'
      hit.untilChapter = u.untilChapter
      hit.supersededBy = u.supersededBy
    }
  }
  supersede(states, plan.supersedeStates)
  supersede(knowledge, plan.supersedeKnowledge)

  const seenE = new Set(events.map((x) => x.id))
  const appendedEvents = []
  for (const e of plan.newEvents) {
    if (seenE.has(e.id)) continue
    seenE.add(e.id)
    appendedEvents.push(e)
  }

  // ---- 写回 ----
  l.currentState = states.sort(byChapterAsc)
  l.characterKnowledge = knowledge.sort(byChapterAsc)
  l.stateEvents = [...events, ...appendedEvents]

  return {
    ok: true,
    batchKey: plan.batchKey,
    fingerprint: plan.fingerprint,
    // warning 也要在成功路径上送达调用方 —— 否则「跳过了一两条」这件事
    // 只写在计划里，上层永远看不见（踩过）。
    violations: plan.violations || [],
    warnings: plan.warnings || [],
    applied: {
      states: plan.newStates.length,
      knowledge: plan.newKnowledge.length,
      events: appendedEvents.length,
      superseded: plan.supersedeStates.length + plan.supersedeKnowledge.length,
    },
    events: appendedEvents,
  }
}

const emptyApplied = () => ({ states: 0, knowledge: 0, events: 0, superseded: 0 })

/**
 * 规划 + 提交。上层（pipeline / applyExtraction）只需要这一个入口。
 * @returns {{ok:boolean, skipped?:boolean, applied:object, violations:Array, plan:object}}
 */
export function applyStateChanges(project, changes = [], ctx = {}) {
  const plan = planStateChanges(project, changes, ctx)
  const res = commitStatePlan(project, plan)
  return { ...res, plan }
}

/* ------------------------------ 历史查询 ------------------------------ */

/**
 * 指定章节的**有效**状态 —— 不是最新状态。
 *
 * 与「取最后一条」的区别：这里按 sinceChapter/untilChapter 判定，
 * 同章往返（A→B→A）下第 3 章查到的仍是第 3 章的 A，而不会因为
 * 后来的 B 被误判；跨章回查（「第 2 章时他在哪」）也得到正确答案。
 */
export function queryStateAt(project, { subjectId = null, attribute = null, chapterNo = null } = {}) {
  return (project?.ledger?.currentState || []).filter(
    (s) =>
      isEffectiveAt(s, chapterNo) &&
      (subjectId === null || s.subjectId === subjectId) &&
      (attribute === null || s.attribute === attribute)
  )
}

/** 指定章节的有效认知（可只查某条事实） */
export function queryKnowledgeAt(project, { characterId = null, fact = null, chapterNo = null } = {}) {
  const want = fact === null ? null : normalizeText(fact)
  return (project?.ledger?.characterKnowledge || []).filter(
    (k) =>
      isEffectiveAt(k, chapterNo) &&
      (characterId === null || k.characterId === characterId) &&
      (want === null || normalizeText(k.fact) === want)
  )
}

/** 某主体某属性的完整变化轨迹（按章号升序，含已被替代的历史） */
export function queryStateTimeline(project, { subjectId, attribute = null } = {}) {
  return (project?.ledger?.currentState || [])
    .filter((s) => s.subjectId === subjectId && (attribute === null || s.attribute === attribute))
    .sort(byChapterAsc)
}

/** 某角色对某条事实的认知演变（suspects → believes → knows） */
export function queryKnowledgeHistory(project, { characterId, fact = null } = {}) {
  const want = fact === null ? null : normalizeText(fact)
  return (project?.ledger?.characterKnowledge || [])
    .filter((k) => k.characterId === characterId && (want === null || normalizeText(k.fact) === want))
    .sort(byChapterAsc)
}

/** 指定章节的全量有效快照（当前世界的「截面」） */
export function currentSnapshot(project, { chapterNo = null } = {}) {
  return {
    chapterNo,
    states: queryStateAt(project, { chapterNo }),
    knowledge: queryKnowledgeAt(project, { chapterNo }),
  }
}

/**
 * 证据溯源：从一条状态/认知或一个事件，找回它来自哪一章、哪个正文版本、正文的哪一段。
 * 第 2 轮评审要求「状态事件能够关联来源正文版本及具体位置」——这就是那个出口。
 */
export function queryEvidence(project, { stateId = null, eventId = null } = {}) {
  const l = project?.ledger || {}
  let record = null
  let event = null
  if (eventId) event = (l.stateEvents || []).find((e) => e.id === eventId) || null
  const targetId = stateId || event?.toStateId || null
  if (targetId) {
    record =
      (l.currentState || []).find((s) => s.id === targetId) ||
      (l.characterKnowledge || []).find((k) => k.id === targetId) ||
      null
  }
  if (!event && record?.eventId) event = (l.stateEvents || []).find((e) => e.id === record.eventId) || null
  if (!record && !event) return null
  return {
    record,
    event,
    sourceChapter: record?.sourceChapter ?? event?.sourceChapter ?? null,
    sourceVersion: record?.sourceVersion ?? event?.sourceVersion ?? null,
    sourceSpan: record?.sourceSpan ?? event?.sourceSpan ?? null,
  }
}

/** 某章产生了哪些状态事件 —— 复盘一章改了什么，看这一个函数就够 */
export function queryEventsAtChapter(project, chapterNo) {
  return (project?.ledger?.stateEvents || []).filter((e) => chOf(e.chapterNo) === chOf(chapterNo))
}

/* ------------------------------ 迁移补齐 ------------------------------ */

/**
 * 给 R2 之前就已存在的账本补上「事件日志 + 转移字段」（确定性，不调模型）。
 *
 * 三条纪律（与迁移脚本一致）：
 *   · 不伪造证据 —— 旧数据无从得知上一个取值，`fromValue` 一律留空，不编造；
 *     正文版本与位置同理，留 null 等反向提取去补。
 *   · 可重复执行 —— 只补缺不覆盖；`eventSeq` 由「同章同键出现次序」确定性推出，
 *     重跑得到同一结果。
 *   · 同键多条 active 只保留一条 —— 取章号最晚者，其余转入 superseded 并写明
 *     被谁替代。这一步让「当前状态」这个概念在旧数据上也自洽（评审补充 1）。
 *
 * @returns {{addedEvents:number, superseded:number, seqFilled:number, notes:string[]}}
 */
export function backfillTransitions(project, { batchKey = 'migrate:v2-r2' } = {}) {
  const notes = []
  if (!project.ledger) project.ledger = emptyLedger()
  const l = project.ledger
  for (const k of ['canonicalFacts', 'currentState', 'characterKnowledge', 'plotThreads', 'stateEvents']) {
    if (!Array.isArray(l[k])) l[k] = []
  }

  const entries = [
    ...l.currentState.map((rec) => ({ rec, kind: 'state', key: activeKeyOf(rec) })),
    ...l.characterKnowledge.map((rec) => ({ rec, kind: 'knowledge', key: activeKeyOf(rec) })),
  ]

  /* --- 1) 同键多条 active：只留章号最晚的一条 --- */
  const groups = new Map()
  for (const it of entries) {
    if (!groups.has(it.key)) groups.set(it.key, [])
    groups.get(it.key).push(it)
  }
  let superseded = 0
  for (const items of groups.values()) {
    const actives = items.filter((i) => !i.rec.status || i.rec.status === 'active').sort((a, b) => byChapterAsc(a.rec, b.rec))
    if (actives.length <= 1) continue
    const winner = actives[actives.length - 1]
    for (const i of actives) {
      if (i === winner) continue
      i.rec.status = 'superseded'
      i.rec.untilChapter = chOf(winner.rec.sinceChapter)
      i.rec.supersededBy = winner.rec.id
      superseded++
    }
  }
  if (superseded) notes.push(`同键遗留 active 收尾 ${superseded} 条`)

  /* --- 2) 补齐转移字段与事件日志 --- */
  const ordered = entries
    .slice()
    .sort((a, b) => {
      const ca = chOf(a.rec.sinceChapter) ?? -1
      const cb = chOf(b.rec.sinceChapter) ?? -1
      if (ca !== cb) return ca - cb
      return String(a.rec.id).localeCompare(String(b.rec.id))
    })

  const seqCounters = new Map()
  let seqFilled = 0
  let addedEvents = 0
  for (const { rec, kind } of ordered) {
    const ch = chOf(rec.sinceChapter)
    const seqKey = kind === 'state' ? `${rec.subjectId}|${rec.attribute}|${ch}` : `${rec.characterId}|belief|${ch}`
    const seq = seqCounters.get(seqKey) || 0
    seqCounters.set(seqKey, seq + 1)

    if (rec.eventSeq === undefined || rec.eventSeq === null) {
      rec.eventSeq = seq
      seqFilled++
    }
    if (rec.untilChapter === undefined) rec.untilChapter = null
    if (rec.supersededBy === undefined) rec.supersededBy = null
    if (rec.sourceChapter === undefined) rec.sourceChapter = rec.sinceChapter ?? null
    if (rec.sourceVersion === undefined) rec.sourceVersion = null
    if (rec.sourceSpan === undefined) rec.sourceSpan = null
    if (rec.eventId) continue

    const ev = makeStateEvent({
      kind,
      subjectId: kind === 'state' ? rec.subjectId : rec.characterId,
      attribute: kind === 'state' ? rec.attribute : 'belief',
      fromValue: null, // 旧数据不知道上一个值，留空而不编造
      toValue: kind === 'state' ? rec.value : rec.belief,
      fromStateId: null,
      toStateId: rec.id,
      chapterNo: rec.sinceChapter ?? null,
      seq: rec.eventSeq,
      idempotencyKey: opIdempotencyKey({ chapterNo: rec.sinceChapter ?? null, batchKey, kind, parts: [rec.id] }),
      batchKey,
      seqKey,
      trust: rec.trust ?? TRUST.LEGACY_UNVERIFIED,
      sourceChapter: rec.sourceChapter,
      sourceVersion: rec.sourceVersion,
      sourceSpan: rec.sourceSpan,
    })
    rec.eventId = ev.id
    l.stateEvents.push(ev)
    addedEvents++
  }
  if (addedEvents) notes.push(`状态事件日志补齐 ${addedEvents} 条（fromValue 留空，不伪造证据）`)
  if (seqFilled) notes.push(`状态/认知记录补 eventSeq ${seqFilled} 条`)

  return { addedEvents, superseded, seqFilled, notes }
}
