/**
 * 概要审查（auditWriterSummaries）的**诊断脚本** —— 不是回归测试，是取证。
 *
 * 目的：回答「硬匹配到底漏了什么、误报什么」。
 *   把两份真实作品的每一章 writerSummary / writerGoal 摊开，逐条列出：
 *     · 命中项（当前会报警的）
 *     · 被三条降噪规则剔掉的候选（记明是哪条规则剔的）
 *     · payoff 独有词项里**根本没在任何章节出现**的（这是硬匹配的盲区：
 *       模型改写成别的说法时，词项命中抓不到）
 *
 * 跑法：node scripts/diag-summary-audit.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { auditWriterSummaries } from '../server/pipeline.js'

const here = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(here, '..', 'data', 'projects')

/* ---- 与产品同源的片段切分（复制一份，便于打印中间态） ---- */
const segments = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ').split(/\s+/).filter(Boolean)
const snippets = (s) => {
  const out = new Set()
  for (const seg of segments(s)) {
    for (let len = 3; len <= 8; len++) {
      for (let i = 0; i + len <= seg.length; i++) out.add(seg.slice(i, i + len))
    }
  }
  return out
}
const VIRTUAL_HEAD = /^(的|了|是|在|和|与|也|都|就|又|而|但|却|把|被|让|给|对|从|向|为|以|之|其|这|那|不|很|最|一)/
const VIRTUAL_TAIL = /(的|了|是|和|与|在|之|其|而|但|却|也|都|就|又|把|被|让|给|对|从|向|为|以|着|过)$/
const isVirtual = (w) => VIRTUAL_HEAD.test(w) || VIRTUAL_TAIL.test(w)

/**
 * 【判据预演】「提出悬念」vs「给出答案」的确定性区分。
 *
 * 诊断发现的缺口：第 2 章概要「发现旧部志最后一页写着自己的名字」——
 * 这正是 f1 payoff 的前半段，但它是**合法的悬念提出**（读者就该在这一章好奇）。
 * 纯词项命中分不清「提出疑问」和「揭晓答案」。
 *
 * 这里试一套确定性判据：看命中片段**所在的那一小句**里有没有
 *   · 悬念词（发现/察觉/不明白/为什么/似乎/好像/竟然…）⇒ 倾向悬念
 *   · 泄底词（因为/其实/原来/是为了/意味着/证明/真相是…）⇒ 倾向泄底
 * 两边都没有 ⇒ 无法判定，标记为「待人工/待模型」。
 */
const SUSPENSE = /(发现|察觉|注意|疑惑|不明白|为何|为什么|似乎|好像|仿佛|竟然|居然|奇怪|异常|没有解释|不解释|回避|隐瞒着什么|说不清|未解|谜)/
const REVEAL = /(因为|其实|原来|真相|是为了|意味着|证明|说明|这才知道|终于明白|原来如此|原因是|实为|正是为了|揭示|揭露)/

function classify(haystack, frag) {
  const idx = haystack.indexOf(frag)
  if (idx < 0) return 'unknown'
  // 取命中片段前后各 24 字，作为「这一小句」的近似
  const win = haystack.slice(Math.max(0, idx - 24), idx + frag.length + 24)
  const hasS = SUSPENSE.test(win)
  const hasR = REVEAL.test(win)
  if (hasR && !hasS) return 'reveal'
  if (hasS && !hasR) return 'suspense'
  if (hasS && hasR) return 'both'
  return 'bare' // 只有词项重合，无语气词 —— 最需要人判断
}

let totalHit = 0
let totalBlind = 0

for (const file of readdirSync(DATA).filter((f) => f.endsWith('.json'))) {
  const raw = JSON.parse(readFileSync(resolve(DATA, file), 'utf8'))
  const project = raw.project || raw
  const volumes = project.outline?.volumes || []
  const foreshadows = project.outline?.foreshadows || []
  const entities = project.entities || []

  console.log(`\n${'='.repeat(78)}`)
  console.log(`作品 ${project.title}（${file}）  章：${(project.chapters || []).length}  伏笔：${foreshadows.length}`)
  console.log('='.repeat(78))

  // ---- 1. 产品当前会报的命中 ----
  const hit = auditWriterSummaries(volumes, foreshadows, project)
  totalHit += hit.length
  console.log(`\n[A] 产品当前命中（会报警）：${hit.length} 条`)
  for (const it of hit) console.log(`    · 第 ${it.chapterNo} 章 ${it.foreshadowId} 片段「${it.fragment}」`)

  // ---- 2. 被降噪规则剔掉的候选 ----
  const liveFs = foreshadows.filter((f) => String(f?.payoff || '').trim())
  const publicFromSeeds = new Set()
  for (const f of liveFs) for (const s of snippets(f.seed)) publicFromSeeds.add(s)
  const publicFromCast = new Set()
  for (const e of entities) {
    for (const s of snippets([e.name, e.publicIdentity, e.publicRole, e.authorRole].filter(Boolean).join(' '))) {
      publicFromCast.add(s)
    }
  }
  const chapters = volumes.flatMap((v) => v?.chapters || []).filter((c) => `${c?.writerSummary || ''}${c?.writerGoal || ''}`.trim())

  console.log(`\n[B] 被三条降噪规则剔除的候选（说明规则在起作用）`)
  const byRule = { seed: [], cast: [], virtual: [], notFound: [] }
  for (const f of liveFs) {
    const payoffSnips = [...snippets(f.payoff)]
    const hitSnips = new Set(hit.filter((h) => h.foreshadowId === f.id).map((h) => h.fragment))
    for (const s of payoffSnips) {
      // 只看「真在某章出现」的，才值得讨论剔得对不对
      const appears = chapters.some((c) => `${c.writerSummary || ''} ${c.writerGoal || ''}`.includes(s))
      if (s.split('').length > 8) continue
      if (!appears) continue
      if (hitSnips.has(s)) continue
      if (publicFromSeeds.has(s)) { byRule.seed.push([f.id, s]); continue }
      if (publicFromCast.has(s)) { byRule.cast.push([f.id, s]); continue }
      if (isVirtual(s)) { byRule.virtual.push([f.id, s]); continue }
    }
  }
  const names = { seed: '命中 seed（跨伏笔算公开）', cast: '命中角色公开信息', virtual: '虚词开头/结尾' }
  for (const k of ['seed', 'cast', 'virtual']) {
    const uniq = [...new Set(byRule[k].map((x) => x.join('｜')))].slice(0, 12)
    console.log(`    ${names[k]}：${byRule[k].length} 处` + (uniq.length ? `  例：${uniq.slice(0, 6).map((x) => '「' + x.split('｜')[1] + '」').join(' ')}` : ''))
  }

  // ---- 3. 硬匹配的盲区：payoff 的核心词在概要里换了个说法 ----
  console.log(`\n[C] 硬匹配盲区（payoff 里没在任何 writerSummary/writerGoal 出现的词项）`)
  for (const f of liveFs) {
    const snips = [...snippets(f.payoff)].filter((s) => s.length >= 3 && !isVirtual(s) && !publicFromSeeds.has(s) && !publicFromCast.has(s))
    const never = snips.filter((s) => !chapters.some((c) => `${c.writerSummary || ''} ${c.writerGoal || ''}`.includes(s)))
    // 只报「长度 >= 4」的，短词没意义
    const notable = never.filter((s) => s.length >= 4)
    if (notable.length) {
      totalBlind += notable.length
      console.log(`    [${f.id}] payoff: ${String(f.payoff).slice(0, 46)}`)
      console.log(`         从未出现（${notable.length} 个）：${notable.slice(0, 8).map((s) => '「' + s + '」').join(' ')}`)
    }
  }

  console.log(`\n[D] 现有 writerSummary 抽样（供人工判断是否真泄露）`)
  for (const c of chapters.slice(0, 8)) {
    console.log(`    第 ${c.no} 章 概要：${String(c.writerSummary || '').slice(0, 70)}`)
    if (c.writerGoal) console.log(`             目标：${String(c.writerGoal).slice(0, 70)}`)
  }
}

console.log(`\n${'='.repeat(78)}`)
console.log(`合计：产品命中 ${totalHit} 条；硬匹配盲区词项 ${totalBlind} 个`)
console.log('='.repeat(78))
