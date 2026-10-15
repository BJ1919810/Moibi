/**
 * prompt harness 验证：让模型审「章节概要是否泄露了伏笔的回收真相」。
 *
 * 背景：现有 auditWriterSummaries 是**硬匹配**（payoff 的 3~8 字 n-gram 逐字命中）。
 * 诊断脚本 scripts/diag-summary-audit.mjs 显示：
 *   硬匹配在真实作品上命中 2 条（「观察记录」「雨天走廊」），
 *   但第 2 章概要「发现旧部志最后一页**写着自己的名字**」
 *   正是 f1 payoff（「预写名字，等待能打破循环的人」）的前半段 —— 硬匹配抓不到。
 *
 * 本脚本用**同一份数据**跑一次模型复查，对比两边结果。
 * 成本：1 次调用（约 ¥0.001~0.003）。
 *
 * 跑法：node scripts/diag-audit-harness.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chat } from '../server/providers/openai.js'
import { auditWriterSummaries } from '../server/pipeline.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'))
const project = JSON.parse(readFileSync(resolve(ROOT, 'data', 'projects', 'p_b4aebdfef1c9.json'), 'utf8'))

const volumes = project.outline?.volumes || []
const foreshadows = (project.outline?.foreshadows || []).filter((f) => String(f?.payoff || '').trim())
const chapters = volumes.flatMap((v) => v?.chapters || []).filter((c) => String(c?.writerSummary || '').trim())

/* ------------------------------ 提示词 ------------------------------ */

const SYSTEM = `你是长篇小说的**剧情一致性审查员**。你的唯一任务是判断：某章的"表层概要"是否**把伏笔的回收真相（结局/答案）提前写成了读者可见的内容**。

关键判据：
- 表层概要（writerSummary）是**读者读这一章时能知道的事**，只能包含公开信息与"悬念的提出"。
- 回收真相（payoff）是**作者侧的秘密**，是伏笔最终要揭晓的答案，绝不能出现在表层概要里。
- **提出悬念是合法的**：概要写"发现旧部志最后一页有自己的名字"是提出悬念，合法。
- **给出答案是泄露**：概要写"那是三十年前预写名字等待破局者，遥一直隐瞒"是给出答案，泄露。
- 同一个意象/短语两边都出现**不必然**是泄露（可能只是场景名）。

对每一章，只有当你**确信**概要里出现了回收真相的答案（而不只是悬念或场景名）时，才报出来。
不要为了凑数而报。没发现问题就返回空数组。

只输出 JSON：{"issues":[{"chapterNo":2,"foreshadowId":"f1","fragment":"概要里泄露真相的原话片段","reason":"为什么这算泄露"}]}`

function buildUser() {
  const fsList = foreshadows.map((f) => `- id=${f.id}\n  表层线索(seed/公开)：${f.seed}\n  回收真相(payoff/作者侧)：${f.payoff}`).join('\n')
  const chList = chapters.map((c) => `- 第 ${c.no} 章 表层概要：${c.writerSummary}${c.writerGoal ? `\n  写作目标：${c.writerGoal}` : ''}`).join('\n')
  return `【伏笔清单】\n${fsList}\n\n【章节表层概要】\n${chList}\n\n请逐章审查，找出把回收真相（答案）写进表层概要的章节。返回 JSON。`
}

/* ------------------------------ 执行 ------------------------------ */

console.log('=== 硬匹配（auditWriterSummaries）结果 ===')
const hard = auditWriterSummaries(volumes, foreshadows, project)
for (const it of hard) console.log(`  · 第 ${it.chapterNo} 章 ${it.foreshadowId}「${it.fragment}」`)
if (!hard.length) console.log('  （无）')

console.log('\n=== 调用模型复查… ===')
const t0 = Date.now()
const res = await chat({
  baseURL: cfg.baseURL,
  apiKey: cfg.apiKey,
  model: cfg.model,
  messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildUser() }],
  temperature: 0.2,
  maxTokens: 1500,
  jsonMode: true,
  thinking: false,
  timeoutMs: 120000,
  retries: 0,
})
const ms = Date.now() - t0
console.log(`模型耗时 ${ms}ms  usage=${JSON.stringify(res.usage)}`)

console.log('\n=== 模型复查结果 ===')
let parsed = null
try {
  const m = String(res.text).match(/\{[\s\S]*\}/)
  parsed = JSON.parse(m ? m[0] : res.text)
} catch (e) {
  console.log('  解析失败，原始输出：')
  console.log(String(res.text).slice(0, 1200))
}
if (parsed) {
  const issues = parsed.issues || []
  if (!issues.length) console.log('  （模型认为无泄露）')
  for (const i of issues) console.log(`  · 第 ${i.chapterNo} 章 ${i.foreshadowId}「${i.fragment}」\n      理由：${i.reason}`)
}

console.log('\n=== 对比 ===')
const hardKeys = new Set(hard.map((h) => `${h.chapterNo}|${h.foreshadowId}`))
const modelKeys = new Set((parsed?.issues || []).map((h) => `${h.chapterNo}|${h.foreshadowId}`))
console.log('  两边都报：', [...hardKeys].filter((k) => modelKeys.has(k)).join(', ') || '（无）')
console.log('  仅硬匹配：', [...hardKeys].filter((k) => !modelKeys.has(k)).join(', ') || '（无）')
console.log('  仅模型  ：', [...modelKeys].filter((k) => !hardKeys.has(k)).join(', ') || '（无）')
