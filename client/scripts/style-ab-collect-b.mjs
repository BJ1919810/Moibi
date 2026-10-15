/**
 * 把 B 组（强制长句）的所有样本整合成一份人眼可读的合集。
 * 用途：主人要求「B 组再多写点我看看」——需要连续读多篇才能判断文风稳定性。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../.wb-tmp/style-ab')
const OUT = resolve(__dirname, '../../mobi/outputs/文风实验_B组_强制长句样本集.md')

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function measure(text) {
  const sent = text.split(/(?<=[。！？…])/).map((x) => x.trim()).filter(Boolean)
  const lens = sent.map((x) => x.length)
  const dlg = [...text.matchAll(/[“「"]([^”」"]+)[”」"]/g)].map((m) => m[1])
  return {
    chars: text.length, sent: lens.length,
    meanSent: mean(lens), medSent: median(lens),
    shortPct: lens.length ? (lens.filter((x) => x <= 8).length / lens.length) * 100 : 0,
    longPct: lens.length ? (lens.filter((x) => x >= 25).length / lens.length) * 100 : 0,
    dlg: dlg.length, meanDlg: mean(dlg.map((x) => x.length)),
  }
}

const keys = ['B', 'F']
const all = {}
for (const k of keys) {
  const files = readdirSync(SRC).filter((f) => f.startsWith(`${k}-`) && f.endsWith('.txt'))
    .sort((a, b) => Number(a.split('-')[1].split('.')[0]) - Number(b.split('-')[1].split('.')[0]))
  all[k] = files.map((f, i) => {
    const text = readFileSync(resolve(SRC, f), 'utf8').trim()
    return { idx: i + 1, file: f, text, m: measure(text) }
  })
}

const meta = `
# 文风实验 · B 组（强制长句）样本集

> 实验设计：**同一 packet、同一章（第 1 章）、同一 temperature=0.92，只替换【文风规则】那一段。**
> B 组只改了一件事：把「**短句为主**」换成「**用长句为主**」，并追加口语化要求。

## 先看结论

| 组 | 说明 | 均句长 | 中位句长 | ≤8字短句 | ≥25字长句 | 均段长 | 对白句数 |
|---|---|---|---|---|---|---|---|
| **A** | 基线（「短句为主」） | 15~17.5 | 12.7~15.3 | **28~31%** | 18~24% | 35 | 36~61 |
| **B** | 强制长句（本集） | **32.4** | **27.2** | **19.9%** | **52.3%** | **70** | 5~53 |
| **F** | 长句＋短对白（本集） | **31.7** | ~21 | ~23% | ~45% | ~46 | **49~76** |

**三个要点：**
1. **只改 5 个字的相反指令，句长就翻倍**（中位句长 12.7 → 27.2）⇒ 文风段完全有效。
2. **B 组有代价**：成段的叙述会**吞掉对白**（B#6 只剩 5 句对白）。
3. **F 组是解法**：明确要求「叙述写长、但对白要短而密」⇒ **长句和活人味可以兼得**（F#3 有 76 句对白）。

---

## B 组逐篇

`
let body = ''
for (const it of all.B) {
  const m = it.m
  body += `\n### B#${it.idx}　${m.chars} 字 · 均句长 ${m.meanSent.toFixed(1)} · 中位 ${m.medSent} · ≤8字 ${m.shortPct.toFixed(0)}% · ≥25字 ${m.longPct.toFixed(0)}% · 对白 ${m.dlg} 句\n\n`
  body += `${it.text}\n\n---\n`
}
body += `\n## F 组逐篇（长叙述＋短对白，推荐方向）\n`
for (const it of all.F) {
  const m = it.m
  body += `\n### F#${it.idx}　${m.chars} 字 · 均句长 ${m.meanSent.toFixed(1)} · 中位 ${m.medSent} · ≤8字 ${m.shortPct.toFixed(0)}% · ≥25字 ${m.longPct.toFixed(0)}% · 对白 ${m.dlg} 句\n\n`
  body += `${it.text}\n\n---\n`
}

body += `\n*说明：以上为单变量实验产出，非投稿正文，仅供语感比对。*\n`

writeFileSync(OUT, meta + body, 'utf8')
console.log('已写出：', OUT)
console.log(`B 组 ${all.B.length} 篇 | F 组 ${all.F.length} 篇`)
