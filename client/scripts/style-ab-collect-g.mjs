/**
 * G 组样章合集：文风规则整段删掉后，模型自己会写出什么。
 * 用来回答主人的问题：「假设句子要求从来不存在，模型会输出什么？」
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../.wb-tmp/style-ab')
const OUT = resolve(__dirname, '../../mobi/outputs/文风实验_G组_无文风指令样本集.md')

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function measure(t) {
  const sent = t.split(/(?<=[。！？…])/).map((x) => x.trim()).filter(Boolean)
  const para = t.split('\n').map((x) => x.trim()).filter(Boolean)
  const dlg = [...t.matchAll(/[“「"]([^”」"]+)[”」"]/g)].map((m) => m[1])
  const L = sent.map((x) => x.length)
  const P = para.map((x) => x.length)
  const head = t.slice(0, 700)
  const first = (head.match(/我/g) || []).length
  const third = (head.match(/他(?!们)|她(?!们)|林昭/g) || []).length
  return {
    chars: t.length, meanSent: mean(L), medSent: median(L),
    shortPct: L.length ? (L.filter((x) => x <= 8).length / L.length) * 100 : 0,
    longPct: L.length ? (L.filter((x) => x >= 25).length / L.length) * 100 : 0,
    meanPara: mean(P), dlg: dlg.length,
    person: first > third ? '第一人称' : '第三人称',
    first, third,
  }
}

const files = readdirSync(SRC).filter((f) => f.startsWith('G-') && f.endsWith('.txt'))
  .sort((a, b) => Number(a.split('-')[1].split('.')[0]) - Number(b.split('-')[1].split('.')[0]))
const items = files.map((f) => { const text = readFileSync(resolve(SRC, f), 'utf8').trim(); return { file: f, text, m: measure(text) } })

const FENCE = String.fromCharCode(96, 96, 96) // ``` 避免模板字面量里嵌套反引号
const head = [
  '',
  '# 文风实验 · G 组（整段文风规则全部删掉）',
  '',
  '> **实验问题（主人提）**：「假设句子要求从来不存在呢？你不提试试看模型会不会输出短长句。」',
  '',
  '## 实验怎么做的',
  '',
  '写成提示词时本来有一整段【文风规则】，包含「第一人称限知」与「短句为主」等内容。',
  '**G 组把这一段（含标题）整段物理删除**（提示词少 230 字），',
  '其余一切不变：同一 packet、同一章（第 1 章）、同一 temperature=0.92。',
  '',
  '## 结果：不说话的模型，反而写得更舒展',
  '',
  '| 组 | n | 均句长 | 中位 | ≤8字 | ≥25字 | 段长 |',
  '|---|---|---|---|---|---|---|',
  '| A 基线（短句为主） | 3 | 17.5 | 15.3 | **28%** | 24% | 35 |',
  '| **G 文风整段全删** | 8 | **20.5** | **17.7** | **22%** | 32% | 46 |',
  '| D 只删系统「缩短句子」 | 8 | 20.3 | 17.5 | 21% | 32% | 46 |',
  '',
  '**⇒ 一个字都不提，模型给出的句子比「短句为主」那一组还要长。**',
  '**⇒ 且 G ≈ D ≈ C ≈ E（全部 20~21）——它们的唯一共同点是「没有任何句子长短指令」。**',
  '**⇒ 存在一个天然基线 ≈ 中位 17~18，不去干扰它就在那儿。**',
  '',
  '## ⚠️ 但 G 组暴露了一个副作用：人称丢失',
  '',
  '| 组 | 第一人称 | 说明 |',
  '|---|---|---|',
  '| A / B / C / D / E / F | **全部 100%** | 文风段里写着「第一人称限知」 |',
  '| **G** | **0 / 8（全部第三人称）** | 整段删掉后，连人称也一起丢了 |',
  '',
  '**⇒ 文风段不只是「句子长短」的载体，它还承担着「叙述人称/视角」这类硬约束。**',
  '**⇒ 所以正确做法不是「整段删掉」，而是「删掉句子长短的干扰信号、保留人称等硬约束」。**',
  '',
  '---',
  '',
  '## G 组逐篇',
  '',
].join('\n')
let body = ''
for (const it of items) {
  const m = it.m
  body += `\n### ${it.file}　${m.chars} 字 · 均句长 ${m.meanSent.toFixed(1)} · 中位 ${m.medSent} · ≤8字 ${m.shortPct.toFixed(0)}% · ≥25字 ${m.longPct.toFixed(0)}% · 段长 ${m.meanPara.toFixed(0)} · ⚠️ **${m.person}**\n\n`
  body += `${it.text}\n\n---\n`
}

writeFileSync(OUT, head + body, 'utf8')
console.log('已写出：', OUT)
console.log(`G 组 ${items.length} 篇`)
