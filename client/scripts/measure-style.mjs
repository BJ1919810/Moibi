/**
 * 文风体检：量化「短词短句 / 文青病」的严重程度。
 *
 * 用法：node scripts/measure-style.mjs [projectId]
 * 输出：句长、段长、对白占比、短句占比、以及「文青病」特征词命中数。
 *
 * 为什么需要它：主人反馈「显式指定文风也改不掉 deepseek 的短句癖」。
 * 靠肉眼读着难受是主观的，先把它变成可复现的数字，才能验证修法有没有用。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(__dirname, '../data/projects')

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : '—')

/** 「文青病」特征词：矫情/空洞/物哀/排比堆砌，命中越多越像散文诗 */
const AI_LITERARY = [
  '仿佛', '像是', '似乎', '某种', '某种东西', '无声地', '静静地', '轻轻地', '缓缓地',
  '一丝', '一抹', '一缕', '几分', '些许', '微不可察', '不易察觉', '几不可闻',
  '有什么东西', '某种情绪', '说不清', '道不明', '莫名的', '恍然', '悄然',
  '像是在诉说', '如同', '映照', '沁入', '缱绻', '旖旎', '氤氲', '弥散', '弥漫',
]

/** 短句癖的判定：≤8 字独立成句（往往是被切碎的伪节奏） */
function analyzeChapters(chapters) {
  const sentLens = []
  const paraLens = []
  const dialogues = []
  const literaryHits = new Map()
  let total = 0
  for (const c of chapters) {
    const t = String(c.text || '')
    total += t.length
    for (const s of t.split(/(?<=[。！？…])/)) {
      const x = s.trim()
      if (x) sentLens.push(x.length)
    }
    for (const p of t.split('\n')) {
      const x = p.trim()
      if (x) paraLens.push(x.length)
    }
    for (const m of t.matchAll(/[“「"]([^”」"]+)[”」"]/g)) dialogues.push(m[1].length)
    for (const w of AI_LITERARY) {
      const n = (t.match(new RegExp(w, 'g')) || []).length
      if (n) literaryHits.set(w, (literaryHits.get(w) || 0) + n)
    }
  }
  const shortSent = sentLens.filter((x) => x <= 8).length
  const longPara = paraLens.filter((x) => x >= 100).length
  const litTotal = [...literaryHits.values()].reduce((a, b) => a + b, 0)
  return {
    total,
    sentCount: sentLens.length,
    meanSent: mean(sentLens),
    medianSent: median(sentLens),
    shortSentPct: pct(shortSent, sentLens.length),
    paraCount: paraLens.length,
    meanPara: mean(paraLens),
    medianPara: median(paraLens),
    longParaPct: pct(longPara, paraLens.length),
    dialogCount: dialogues.length,
    dialogRatio: pct(dialogues.length, sentLens.length),
    meanDialog: mean(dialogues),
    literaryPer1k: total ? ((litTotal / total) * 1000).toFixed(1) : '0',
    literaryTop: [...literaryHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  }
}

const only = process.argv[2]
const files = readdirSync(DATA).filter((f) => f.endsWith('.json'))
for (const f of files) {
  if (only && !f.includes(only)) continue
  const p = JSON.parse(readFileSync(resolve(DATA, f), 'utf8'))
  const chapters = (p.chapters || []).filter((c) => c.text)
  if (!chapters.length) continue
  const r = analyzeChapters(chapters)
  console.log(`\n=== ${p.title || '(无题)'} · ${f} ===`)
  console.log(`  规模    ${chapters.length} 章 / ${r.total} 字`)
  console.log(`  句长    均 ${r.meanSent.toFixed(1)} 中位 ${r.medianSent} | ≤8字短句 ${r.shortSentPct}`)
  console.log(`  段长    均 ${r.meanPara.toFixed(1)} 中位 ${r.medianPara} | ≥100字长段 ${r.longParaPct} | 共 ${r.paraCount} 段`)
  console.log(`  对白    ${r.dialogCount} 句（占句子 ${r.dialogRatio}）均长 ${r.meanDialog.toFixed(1)}`)
  console.log(`  文青词  ${r.literaryPer1k} 次/千字 | top: ${r.literaryTop.map(([w, n]) => `${w}×${n}`).join(' ')}`)
}
