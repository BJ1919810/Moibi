/**
 * R3 旧作品可信记忆恢复。
 *
 * 旧 facts/threads 只是无出处的自然语言推断，不能因写在数组里就升级为事实。
 * 唯一可以在程序层自动确证的情况：待恢复文本逐字出现在某章已提交正文中。
 * 其他候选保留隔离；任何语义转述都需要模型提出证据、再经用户/人工复核。
 * 该模块不调用外部 API，也不依据未来章节的计划重建已发生事实。
 */
import { TRUST, makeFact, makeThread } from './schema.js'
import { ensureLedger, matchNames, makeNameResolver } from './ledger.js'
import { applyStateChanges } from './state-engine.js'

function chapterSources(project) {
  return (project.chapters || []).filter((c) => c.status === 'committed' && typeof c.text === 'string')
    .sort((a, b) => a.no - b.no)
}

/** 只恢复可以逐字定位的旧 fact/thread，不碰未经确认的语义归纳。 */
export function recoverLiteralLegacyRecords(project) {
  const ledger = ensureLedger(project)
  const sources = chapterSources(project)
  const report = { restored: { facts: [], threads: [] }, pending: { facts: [], threads: [] } }
  for (const [bucket, name] of [['canonicalFacts', 'facts'], ['plotThreads', 'threads']]) {
    for (const item of ledger[bucket]) {
      if (item.trust !== TRUST.LEGACY_UNVERIFIED) continue
      const text = String(item.text || '').trim()
      // 过短片段可能是无意义的词，不能仅凭两三个字判作可信事实。
      const evidence = text.length >= 8 && sources.find((c) => c.text.includes(text))
      if (!evidence) { report.pending[name].push(item.id); continue }
      const offset = evidence.text.indexOf(text)
      item.trust = TRUST.CANONICAL
      item.verified = true
      item.sourceChapter = evidence.no
      item.sourceVersion = evidence.sourceVersion ?? `legacy-ch${evidence.no}`
      item.sourceSpan = { start: offset, end: offset + text.length, quote: text }
      item.recoveryMethod = 'literal-exact-match'
      report.restored[name].push(item.id)
    }
  }
  return report
}

/**
 * 将模型给出的恢复候选记录为待审核信息；不擅自把模型判断记为 canonical。
 * evidence 必须是正文真正存在的短引文（8 字以上），禁止伪造 sourceSpan。
 * 仅在 reviewed=true 且明确传 reviewer 时，允许经过人工核实的语义转述进入正式库。
 */
export function recoverReviewedProposals(project, proposals = [], { reviewed = false, reviewer = null } = {}) {
  const ledger = ensureLedger(project)
  const chapters = new Map(chapterSources(project).map((c) => [c.no, c]))
  const results = []
  for (const proposal of proposals) {
    const chapter = chapters.get(Number(proposal.chapterNo))
    const quote = String(proposal.evidence || '').trim()
    const offset = chapter?.text.indexOf(quote) ?? -1
    if (!chapter || quote.length < 8 || offset < 0) {
      results.push({ ok: false, reason: 'evidence-not-in-accepted-chapter' }); continue
    }
    const trust = reviewed && reviewer ? TRUST.CANONICAL : TRUST.NEEDS_REVIEW
    const text = String(proposal.text || quote).trim()
    const source = { sourceChapter: chapter.no, sourceSpan: { start: offset, end: offset + quote.length, quote },
      sourceVersion: chapter.sourceVersion ?? `legacy-ch${chapter.no}` }
    // 逐字证据与语义断言不是同一回事；未经人工审阅时，不提升旧记录的 trust。
    let entry, destination
    if (proposal.kind === 'fact') {
      entry = makeFact({ text, entityIds: matchNames(text, project), sourceChapter: chapter.no, trust, verified: trust === TRUST.CANONICAL })
      destination = ledger.canonicalFacts
    } else if (proposal.kind === 'thread') {
      entry = makeThread({ text, sourceChapter: chapter.no, trust })
      destination = ledger.plotThreads
    } else { results.push({ ok: false, reason: 'unsupported-kind-requires-state-engine' }); continue }
    const previous = destination.find((x) => x.id === entry.id)
    if (previous) {
      // 同一条旧记录由人工核实后升级，不能因为 ID 相同就丢失恢复机会。
      if (trust === TRUST.CANONICAL && previous.trust !== TRUST.CANONICAL) {
        Object.assign(previous, source, { trust, verified: true, recoveryReviewer: reviewer, recoveryMethod: 'reviewed-evidence' })
        entry = previous
      } else { results.push({ ok: false, reason: 'duplicate-or-not-authorized' }); continue }
    } else {
      entry = { ...entry, ...source, recoveryReviewer: reviewer }
      destination.push(entry)
    }
    results.push({ ok: true, id: entry.id, status: trust, chapterNo: chapter.no })
  }
  return results
}

/** 原文引文型安全候选：只标记谁说/写过这句话，不推断陈述为真。 */
export function makeEvidenceCandidates(project, minLength = 10) {
  return chapterSources(project).flatMap((ch) => {
    const paragraphs = ch.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    return paragraphs.filter((p) => p.length >= minLength && p.length <= 100)
      .slice(0, 12).map((p) => ({ kind: 'fact', chapterNo: ch.no,
        text: `第${ch.no}章正文记载：「${p}」`, evidence: p, status: TRUST.NEEDS_REVIEW }))
  })
}

/** 便于 R3 迁移 CLI 输出审核材料；不需要模型服务就能先做证据定位。 */
export function recoveryReport(project) {
  const ledger = ensureLedger(project)
  return { committedChapters: chapterSources(project).map((c) => c.no),
    canonical: ['canonicalFacts', 'currentState', 'characterKnowledge', 'plotThreads'].reduce((r, k) => {
      r[k] = ledger[k].filter((x) => x.trust === TRUST.CANONICAL).length; return r
    }, {}),
    quarantined: ['canonicalFacts', 'currentState', 'characterKnowledge', 'plotThreads'].reduce((r, k) => {
      r[k] = ledger[k].filter((x) => x.trust !== TRUST.CANONICAL).length; return r
    }, {}) }
}

/**
 * 人工审过的状态/认知历史可以重放进入 R2 状态引擎。
 * 要求证据逐字属于已确认正文，且批次按章号递增；失败时引擎保证原子拒绝。
 * 未审核输入仅保留为候选，不进入 active 状态表。
 */
export function recoverStateProposals(project, proposals = [], { reviewed = false, reviewer = null } = {}) {
  const chapters = new Map(chapterSources(project).map((ch) => [ch.no, ch]))
  const prepared = []
  const errors = []
  for (const p of proposals) {
    const ch = chapters.get(Number(p.chapterNo))
    const evidence = String(p.evidence || '').trim()
    const offset = ch?.text.indexOf(evidence) ?? -1
    if (!ch || evidence.length < 8 || offset < 0 || !['state', 'knowledge'].includes(p.kind)) {
      errors.push({ proposal: p, reason: 'unsupported-kind-or-missing-evidence' }); continue
    }
    prepared.push({ ...p, sourceChapter: ch.no, sinceChapter: ch.no,
      sourceVersion: ch.sourceVersion ?? `legacy-ch${ch.no}`,
      sourceSpan: { start: offset, end: offset + evidence.length, quote: evidence } })
  }
  if (!reviewed || !reviewer || errors.length) {
    project.recoveryProposals ||= []
    for (const p of prepared) {
      if (!project.recoveryProposals.some((a) => JSON.stringify(a) === JSON.stringify(p))) {
        project.recoveryProposals.push({ ...p, trust: TRUST.NEEDS_REVIEW })
      }
    }
    return { applied: false, status: 'needsReview', errors, candidates: prepared.length }
  }
  // 跨多章恢复必须先在隔离副本执行；即使第 N 章失败，前 N-1 章也不会部分进入正式账本。
  const shadow = structuredClone(project)
  let applied = 0
  for (const chapterNo of [...new Set(prepared.map((p) => p.sourceChapter))].sort((a,b) => a-b)) {
    const changes = prepared.filter((p) => p.sourceChapter === chapterNo)
    const r = applyStateChanges(shadow, changes, {
      chapterNo, resolveName: makeNameResolver(shadow),
      batchKey: `review:${reviewer}:legacy:${chapterNo}`,
      sourceVersion: `legacy-ch${chapterNo}`,
    })
    if (!r.ok) return { applied: false, status: 'rejected', errors: r.violations, count: 0 }
    applied += r.applied?.events || 0
  }
  project.ledger = shadow.ledger
  return { applied: true, status: TRUST.CANONICAL, count: applied, errors }
}

/**
 * 只把某条直接见于正文的短引文存成“原文观察”，不自行推断其背后的真相。
 * 这些条目用于旧作品即使没有模型接口，也可以恢复少量可溯源的安全事实。
 */
export function recoverVerbatimObservations(project, quotes = []) {
  const l = ensureLedger(project)
  const sources = chapterSources(project)
  const report = { restored: [], missing: [] }
  for (const raw of quotes) {
    const quote = String(raw).trim()
    const ch = sources.find((c) => c.text.includes(quote))
    if (!ch || quote.length < 10) { report.missing.push(quote); continue }
    const entry = makeFact({ text: quote, sourceChapter: ch.no, entityIds: matchNames(quote, project), trust: TRUST.CANONICAL })
    if (l.canonicalFacts.some((f) => f.id === entry.id)) continue
    const start = ch.text.indexOf(quote)
    entry.sourceSpan = { start, end: start + quote.length, quote }
    entry.sourceVersion = ch.sourceVersion ?? `legacy-ch${ch.no}`
    entry.recoveryMethod = 'verbatim-observation'
    l.canonicalFacts.push(entry)
    report.restored.push({ id: entry.id, chapterNo: ch.no, quote })
  }
  return report
}
