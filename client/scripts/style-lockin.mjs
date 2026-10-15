/**
 * 风格锁死检测：相邻章节的文风是否高度相似（= 模型在模仿上一章的尾巴）。
 *
 * 机制假设：projection.js 把「上一章结尾原文」（420 字）塞进提示词，
 * 模型天然会模仿紧邻文本的行文节奏 ⇒ 第 1 章的短句癖被逐章复制放大。
 *
 * 判据：相邻章句长中位数之差 < 2 字 ⇒ 视为锁死。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(__dirname, '../data/projects')

const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sentLens = (t) => t.split(/(?<=[。！？…])/).map((x) => x.trim()).filter(Boolean).map((x) => x.length)

for (const f of readdirSync(DATA).filter((x) => x.endsWith('.json'))) {
  const p = JSON.parse(readFileSync(resolve(DATA, f), 'utf8'))
  const chs = (p.chapters || []).filter((c) => c.text).sort((a, b) => a.no - b.no)
  if (chs.length < 3) continue
  const meds = chs.map((c) => ({ no: c.no, med: median(sentLens(c.text)), n: sentLens(c.text).length }))
  let locked = 0
  for (let i = 1; i < meds.length; i++) if (Math.abs(meds[i].med - meds[i - 1].med) < 2) locked++
  const vals = meds.map((m) => m.med)
  console.log(`\n=== ${p.title || f} ===`)
  console.log('  各章句长中位：' + meds.map((m) => `${m.no}:${m.med}`).join(' '))
  console.log(`  相邻章中位数差 <2 字：${locked}/${meds.length - 1} (${((locked / (meds.length - 1)) * 100).toFixed(0)}%)`)
  console.log(`  离散度 min ${Math.min(...vals)} / max ${Math.max(...vals)} / 极差 ${Math.max(...vals) - Math.min(...vals)}`)
}
