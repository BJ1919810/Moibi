/**
 * 文风单变量对照实验（style A/B test）
 *
 * 目的：在**其他一切都不变**的前提下，只替换提示词里的【文风规则】，
 *       看正文的句长/段长/对白是否真的随之改变。
 *
 * 为什么这样设计：
 *   主人的三个假说——
 *     H1 大纲等上下文太「规范」，把正文也带成了公文腔；
 *     H2 提示词里大量「不要 XXX」的约束语气，被正文模型学走了；
 *     H3 文风指令本身就没被遵守（PE 无效）。
 *   要分开它们，必须先把「文风指令」这一个变量单独拎出来跑：
 *   同一份 packet、同一章号、同一 temperature，只换 style 段。
 *
 * 判据：
 *   若 A→B 句长中位数变动 < 2 字，且短句占比变动 < 5 个百分点 ⇒ 文风指令无效（H3）。
 *   若明显变动 ⇒ 指令有效，问题在别处（去看 H1/H2）。
 *
 * 用法：
 *   node scripts/style-ab.mjs                # 默认 3 次/变体
 *   node scripts/style-ab.mjs --runs 2
 *   node scripts/style-ab.mjs --pid p_xxx --no 1
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWriterPacket, buildWriterMessages } from '../server/projection.js'
import { chat } from '../server/providers/openai.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, '.wb-tmp/style-ab')

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const RUNS = Number(arg('runs', 3))
const PID = arg('pid', 'p_49adeeea009c') // 风起处见线（原神穿越）
const NO = Number(arg('no', 1))

const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data/config.json'), 'utf8'))
const project = JSON.parse(readFileSync(resolve(ROOT, `data/projects/${PID}.json`), 'utf8'))
const pidName = project.title || PID

/* ------------------------------- 变体定义 ------------------------------- */

const A_BASE = null // 基线：完全用项目现有文风（不改一字）

/**
 * B：把「短句」这个信号彻底反转 —— 明确要长句、要口语活泼、要给语气词与插话。
 * 这是最激进的一刀：如果连这都拉不动句子长度，说明文风段基本是摆设。
 */
const B_STYLE = {
  base: '第一人称限知（穿越者视角）。**用长句为主**，一句话里可以容纳转折、补充和插入语，'
    + '像真人聊天时一口气说完那样。现代人吐槽与异世界厚重感的落差出戏味；'
    + '描写重具体动作与五感（风、酒香、元素微粒的微光），不用华丽辞藻堆砌。'
    + '场景意象固定在草原的风、蒙德的酒馆、石墙上的风神像、夜里发亮的元素结晶。'
    + '对话要有活人气：允许语气词（哎、我说、你等等、得了）、允许打断、抢话、'
    + '自嘲打岔和没营养的废话，不要每句都对题、不要每句都推进剧情。'
    + '每章至少一处因「现代人常识 vs 异世界逻辑」错位造成的幽默，结尾留一个钩子。',
  rules: [
    '句子的长短要跟着情绪走：叙述、回忆、思考要展开写，别用一两个词草草带过。',
    '段落里至少要有几句是连着几个分句的长句，不要通篇一句话一个句号。',
    '情绪优先用动作与选择表现，不在段尾解释。',
    '对话承担试探与冲突，避免角色复述彼此已知的背景。',
  ],
}

/** 原 styleSpec（去掉"短句为主，"这 5 个字，其余一字不改）—— 想验证：是不是"短句"二字在作祟 */
const C_NEUTRAL = {
  base: '第一人称限知（穿越者视角）。现代人吐槽与异世界厚重感的落差出戏味；'
    + '描写重具体动作与五感（风、酒香、元素微粒的微光），不用华丽辞藻堆砌。'
    + '场景意象固定在草原的风、蒙德的酒馆、石墙上的风神像、夜里发亮的元素结晶。'
    + '每章至少一处因「现代人常识 vs 异世界逻辑」错位造成的幽默，结尾留一个钩子。',
  rules: [
    '紧张处缩短句子，但不要把所有段落写成单句。',
    '情绪优先用动作与选择表现，不在段尾解释。',
    '对话承担试探与冲突，避免角色复述彼此已知的背景。',
  ],
}

/** C 再删掉那条「紧张处缩短句子」的系统 rule —— 想验证系统那 3 条通则的影响 */
const D_RULES_OFF = {
  base: C_NEUTRAL.base,
  rules: [
    '情绪优先用动作与选择表现，不在段尾解释。',
    '对话承担试探与冲突，避免角色复述彼此已知的背景。',
  ],
}

/**
 * E：目标态 —— 「活泼有人情味」的可抄版本。
 * 与 C 的区别：不是单纯求长，而是明确「长短交错 + 口语活人气 + 允许废话」。
 * 想验证的是：主人要的「人情味」能不能靠文风设定直接买到。
 */
const E_LIVELY = {
  base: '第一人称限知（穿越者视角）。长短句交错：叙述、吐槽、心理活动用展开的长句，'
    + '一句话里允许转折、补充和插入语，像真人一口气把话说完；该快的地方才用短句。'
    + '对话要有活人气：允许语气词（哎、我说、你等等、得了）、打断、抢话、自嘲和没用的废话，'
    + '不要每句都对题、不要每句都推进剧情。现代人吐槽与异世界厚重感的落差出戏味；'
    + '描写重具体动作与五感（风、酒香、元素微粒的微光），不用华丽辞藻堆砌。'
    + '场景意象固定在草原的风、蒙德的酒馆、石墙上的风神像、夜里发亮的元素结晶。'
    + '每章至少一处因「现代人常识 vs 异世界逻辑」错位造成的幽默，结尾留一个钩子。',
  rules: [
    '情绪优先用动作与选择表现，不在段尾解释。',
    '对话承担试探与冲突，避免角色复述彼此已知的背景。',
  ],
}

/**
 * F：长句 + 保留对白活人气。
 * B 组的代价是「对白几乎消失」（成段叙述把对话吞掉了）。F 想验证：
 * 「句子长」和「话多、有人味」能不能同时要到 —— 这直接决定文档里该怎么写文风模板。
 */
const F_LONG_WITH_DIALOG = {
  base: '第一人称限知（穿越者视角）。叙述句一律写长：一句话里可以容纳转折、补充和插入语，'
    + '把心理活动、环境细节、前因后果都织进同一个长句里，像真人一口气把话说完。'
    + '但对白要短而密、要活：保留语气词（哎、我说、你等等、得了）、打断、抢话、答非所问，'
    + '用对话推进场景，不要用大段叙述代替对话。'
    + '现代人吐槽与异世界厚重感的落差出戏味；描写重具体动作与五感（风、酒香、元素微粒的微光），'
    + '不用华丽辞藻堆砌。场景意象固定在草原的风、蒙德的酒馆、石墙上的风神像、夜里发亮的元素结晶。'
    + '每章至少一处因「现代人常识 vs 异世界逻辑」错位造成的幽默，结尾留一个钩子。',
  rules: [
    '叙述长句与短对白交替出现，靠节奏差推动场景，不要通篇一种句式。',
    '情绪优先用动作与选择表现，不在段尾解释。',
  ],
}

/**
 * G：**整段文风规则全部删掉**。
 * 与 D 的区别：D 还留着「意象/幽默/结尾钩子」这些内容要求，只是不提句子长短；
 * G 连内容要求都不给，直接测「这个模型 + 这份 packet」的**裸默认文风**。
 * ⇒ 用来回答：短句癖到底是不是模型自带的？
 */
const G_NO_STYLE_AT_ALL = { base: '', rules: [] }

/* ------------------------------- 指标计算 ------------------------------- */

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function measure(text) {
  const sent = text.split(/(?<=[。！？…])/).map((x) => x.trim()).filter(Boolean)
  const para = text.split('\n').map((x) => x.trim()).filter(Boolean)
  const dlg = [...text.matchAll(/[“「"]([^”」"]+)[”」"]/g)].map((m) => m[1])
  const lens = sent.map((x) => x.length)
  const plens = para.map((x) => x.length)
  return {
    chars: text.length,
    sent: lens.length,
    meanSent: mean(lens),
    medSent: median(lens),
    shortPct: lens.length ? (lens.filter((x) => x <= 8).length / lens.length) * 100 : 0,
    longPct: lens.length ? (lens.filter((x) => x >= 25).length / lens.length) * 100 : 0,
    para: plens.length,
    meanPara: mean(plens),
    medPara: median(plens),
    dlg: dlg.length,
    meanDlg: mean(dlg.map((x) => x.length)),
  }
}

/* -------------------------------- 执行 -------------------------------- */

const packet = buildWriterPacket(project, NO, { wordCount: 2600 })
const ALL_VARIANTS = { A: { key: 'A', label: '基线（项目现有文风）', style: A_BASE },
  B: { key: 'B', label: '反转：长句＋口语活泼', style: B_STYLE },
  C: { key: 'C', label: '去掉「短句为主，」5 字', style: C_NEUTRAL },
  D: { key: 'D', label: 'C 再删系统「紧张处缩短句子」', style: D_RULES_OFF },
  E: { key: 'E', label: '目标态：长短交错＋口语活人气', style: E_LIVELY },
  F: { key: 'F', label: '长句＋短对白（两者兼得？）', style: F_LONG_WITH_DIALOG },
  G: { key: 'G', label: '整段文风全删（测裸默认）', style: G_NO_STYLE_AT_ALL } }
// --only B,C 可只跑指定变体（反复采样某组时用），不传则跑 A+E
const onlyArg = arg('only', '')
const variants = onlyArg
  ? onlyArg.split(',').map((x) => ALL_VARIANTS[x.trim()]).filter(Boolean)
  : [ALL_VARIANTS.A, ALL_VARIANTS.E]

mkdirSync(OUT, { recursive: true })
console.log(`项目《${pidName}》 第 ${NO} 章 | 每变体 ${RUNS} 次 | 模型 ${cfg.model}`)
console.log('已固定：packet / 章号 / temperature=0.92，只替换【文风规则】段\n')

const results = {}
for (const v of variants) {
  const p = { ...packet }
  if (v.style) p.style = { base: v.style.base, rules: [...v.style.rules] }
  let messages = buildWriterMessages(p)
  // G 组：把整个【文风规则】段从提示词里物理删除（连标题都不留），才是真正的「不存在」
  if (v.key === 'G') {
    messages = messages.map((m) => ({
      ...m,
      content: String(m.content).replace(/【文风规则】\n[^\n]*\n(?:· [^\n]*\n)*\n?/g, ''),
    }))
    const gone = !messages[1].content.includes('【文风规则】')
    console.log(`  （G 组：文风段已从提示词中移除 = ${gone}）`)
  }
  const styleBlock = `【文风规则】\n${p.style.base}\n${p.style.rules.map((r) => `· ${r}`).join('\n')}`

  results[v.key] = []
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now()
    let text = ''
    try {
      const r = await chat({ ...cfg, messages, temperature: 0.92, maxTokens: 6144, retries: 0, timeoutMs: 300000 })
      text = String(r.text || '').replace(/^\s*第\s*\d+\s*章[^\n]*\n+/, '').trim()
    } catch (e) {
      console.log(`  [${v.key}#${i}] 失败：${String(e.message).slice(0, 80)}`)
      continue
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(0)
    const m = measure(text)
    results[v.key].push(m)
    writeFileSync(resolve(OUT, `${v.key}-${i}.txt`), text, 'utf8')
    console.log(`  [${v.key}#${i}] ${m.chars}字 ${sec}s | 均句长 ${m.meanSent.toFixed(1)} 中位 ${m.medSent} | ≤8字 ${m.shortPct.toFixed(0)}% | ≥25字 ${m.longPct.toFixed(0)}% | 均段长 ${m.meanPara.toFixed(0)} | 对白 ${m.dlg} 句 均 ${m.meanDlg.toFixed(1)}字`)
    if (i === 1) console.log(`     风格段首句：${styleBlock.split('\n')[1].slice(0, 50)}…`)
  }
  console.log()
}

console.log('================ 汇总 ================')
const agg = {}
for (const k of ["A", "B", "C", "D", "E"]) {
  const rs = results[k] || []
  if (!rs.length) continue
  agg[k] = {
    meanSent: mean(rs.map((r) => r.meanSent)),
    medSent: mean(rs.map((r) => r.medSent)),
    shortPct: mean(rs.map((r) => r.shortPct)),
    longPct: mean(rs.map((r) => r.longPct)),
    meanPara: mean(rs.map((r) => r.meanPara)),
    meanDlg: mean(rs.map((r) => r.meanDlg)),
  }
  console.log(`${k}  均句长 ${agg[k].meanSent.toFixed(1)} | 中位句长 ${agg[k].medSent.toFixed(1)} | ≤8字 ${agg[k].shortPct.toFixed(1)}% | ≥25字 ${agg[k].longPct.toFixed(1)}% | 均段长 ${agg[k].meanPara.toFixed(0)} | 对白均长 ${agg[k].meanDlg.toFixed(1)}`)
}
if (agg.A) {
  console.log('\n相对 A（基线）的位移：')
  for (const k of ["B", "C", "D", "E"]) {
    if (!agg[k]) continue
    const d = (x) => (agg[k][x] - agg.A[x]).toFixed(1)
    console.log(`  ${k} − A：句长 ${d('meanSent')} | 中位句长 ${d('medSent')} | ≤8字 ${d('shortPct')}pt | ≥25字 ${d('longPct')}pt | 段长 ${d('meanPara')} | 对白均长 ${d('meanDlg')}`)
  }
}
console.log(`\n正文已存 ${OUT}`)
