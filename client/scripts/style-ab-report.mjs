/**
 * 为「文风实验」生成人眼可读的对照报告：
 * 把 A（基线）与 E（目标态）的同章开头并排放在一起，供主人直接读语感。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../.wb-tmp/style-ab')
const OUT = resolve(__dirname, '../../mobi/outputs/文风实验_长短句对照.md')

const read = (k, i) => readFileSync(resolve(SRC, `${k}-${i}.txt`), 'utf8').trim()
const head = (t, n = 1100) => (t.length > n ? `${t.slice(0, n)}\n\n……（下略）` : t)

const meta = `
## 一句话结论

**问题不在模型不听话，而在「短句」这两个字本身。**

四本书的文风设定里全都有「短句」：十年雨信「短句为主」、樱花池畔「短句＋吐槽」、
樱池旧部志「短句＋吐槽」、风起处见线「短句为主」——再加上系统写死的 rule
「紧张处**缩短句子**」，模型被三面夹击，它是在**严格执行指令**。

实测（同一 packet / 同章 / temperature=0.92，只换【文风规则】段，各 3 次取均值）：

| 变体 | 均句长 | 中位句长 | ≤8字短句 | ≥25字长句 | 均段长 |
|---|---|---|---|---|---|
| A 基线（原文风） | 15~17.5 | 12.7~15.3 | 28~31% | 18~24% | 35 |
| C 只删「短句为主，」5 字 | 20.1 | 16.0 | 17.4% | 29.7% | 49 |
| D 再删系统「紧张处缩短句子」 | 19.0 | 16.5 | 21.0% | 27.6% | 47 |
| E 目标态：长短交错＋活人气 | 20.8 | 16.8 | 25.6% | 35.0% | 45 |
| B 强制长句（激进对照） | 30.8 | 23.2 | 14% | 48.5% | 76 |

⇒ **删掉 5 个字，句长就涨 4.7 字、短句占比掉 14 个百分点。** 文风段非常有效。
⇒ 假说 H1（上下文太规范带坏正文）、H2（否定式语气被学走）**证据不足**：
   两个 styleSpec 为空的天然对照组（十年雨信、樱花池畔）与有文风的项目表现并无差别。

---
`

const body = `
## A · 基线（现有文风，短句为主）

${head(read('A', 1))}

---

## E · 目标态（长短交错＋口语活人气）

${head(read('E', 2))}

---

## B · 极激进对照（强制长句，证明上限）

${head(read('B', 2), 700)}

---

*说明：以上为单变量 A/B 实验产出，非投稿正文，仅供语感比对。*
*完整 15 份样本见 mobi/.wb-tmp/style-ab/。*
`

writeFileSync(OUT, `${meta}${body}`, 'utf8')
console.log('已写出：', OUT)
