/**
 * R5 受控上下文编译器。
 * 权限过滤仍由 projection + ledger 完成；这里只对允许的字段排序、计数、裁剪。
 * Manifest 记录每次真正选入的 ID、来源及理由，供复现和界面检查。
 */
import crypto from 'node:crypto'
import { buildWriterPacket, renderWriterPacket, findLeaks, findChapterMeta } from './projection.js'
import { prepareChapterPlan } from './chapter-planner.js'

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
/** 无供应商 tokenizer 时的保守估算；不得宣称为精确账单 token。 */
export function estimateTokens(s) {
  const str = String(s)
  return Math.max(Math.ceil(str.length * .9), Math.ceil(Buffer.byteLength(str, 'utf8') / 2.4))
}

export class ContextBudgetError extends Error { constructor(s) { super(s); this.name = 'ContextBudgetError' } }

export function compileChapterContext(project, chapterNo, options = {}) {
  const plan = options.plan || prepareChapterPlan(project, chapterNo)
  const requiredFactIds = plan.requiredFactIds || []
  const inputBudget = Number(options.inputBudget ?? 10000)
  if (!Number.isFinite(inputBudget) || inputBudget < 128) throw new ContextBudgetError('上下文预算必须至少为 128 tokens')
  const maxFacts = Number(options.maxFacts ?? 30), maxThreads = Number(options.maxThreads ?? 20)
  let packet, prompt, tokens, selectedCounts
  for (let f = maxFacts, t = maxThreads; f >= 0 && t >= 0;) {
    packet = buildWriterPacket(project, chapterNo, { requiredFactIds, maxFacts: f, maxThreads: t, wordCount: options.wordCount })
    const diagnostics = packet.diagnostics
    if (diagnostics.requiredMissing?.length) throw new Error(`关键依赖不可用：${diagnostics.requiredMissing.join('、')}`)
    if ((diagnostics.selected?.facts || []).filter((id) => requiredFactIds.includes(id)).length !== requiredFactIds.length) {
      throw new ContextBudgetError('必需的历史事实超出预算或检索上限')
    }
    const leaks = findLeaks(packet, project)
    if (leaks.length) throw new Error(`WriterPacket 权限校验失败：${leaks.map((x) => x.type).join('、')}`)
    prompt = renderWriterPacket(packet)
    tokens = estimateTokens(prompt)
    selectedCounts = { facts: f, threads: t }
    if (tokens <= inputBudget) break
    if (t > 0) t--
    else if (f > requiredFactIds.length) f--
    else throw new ContextBudgetError(`必需信息与固定指令超预算：预计 ${tokens}，上限 ${inputBudget}`)
  }
  if (tokens > inputBudget) throw new ContextBudgetError('上下文预算不足')

  const selected = packet.diagnostics.selected || {}
  const ledger = project.ledger || {}
  const buckets = { facts: ledger.canonicalFacts || [], states: ledger.currentState || [], knowledge: ledger.characterKnowledge || [], threads: ledger.plotThreads || [] }
  const entries = []
  for (const [bucket, ids] of Object.entries(selected)) {
    for (const id of ids) {
      const item = buckets[bucket].find((x) => x.id === id)
      entries.push({ id, bucket, sourceChapter: item?.sourceChapter ?? item?.sinceChapter ?? null,
        reason: requiredFactIds.includes(id) ? 'required' : bucket === 'states' || bucket === 'knowledge' ? 'current' : 'related-or-recent',
        revision: item?.sourceVersion ?? null })
    }
  }
  const meta = findChapterMeta(project.outline, chapterNo)
  const manifest = { schemaVersion: 1, chapterNo, headVersion: Number(project.headVersion || 0),
    planRevision: meta?.revision || 1, policy: 'writer-authorized-v2', packetHash: hash(prompt),
    estimatedInputTokens: tokens, inputBudget, entries,
    dropped: packet.diagnostics.truncated, quarantined: packet.diagnostics.quarantined,
    futureSkipped: packet.diagnostics.futureSkipped, selectedCounts }
  return { packet, manifest, plan, prompt }
}
