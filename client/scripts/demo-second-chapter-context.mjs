#!/usr/bin/env node
/**
 * 演示：开一本新书 → 真的写出第 1 章 → 导出**第 2 章正文将要被喂的上下文**。
 *
 * 为什么要「真的写一章」才能看第二章：
 *   `dump-writer-packet.mjs` 只导出**已存在**的作品；而第二章上下文里的
 *   「前情 / 当前状态 / 角色已知 / 尚未了结的线索」全部来自第一章提交后的账本，
 *   不写第一章就全是空的 —— 那看到的不是真实上下文。
 *
 * 用法：node scripts/demo-second-chapter-context.mjs [--no-write] [--chapters=30]
 *   --no-write   只开书、不写第 1 章（省一次模型调用，但第二章前情会是空的）
 *   --chapters  覆盖目标章数（默认 10）
 *
 * ⚠️ 会**真实调用模型**（开书 + 1 章，约 ¥0.02），并且只写它自己新建的那本书。
 * ⚠️ 需要服务已在跑（默认 http://127.0.0.1:8787；用 MOBI_BASE 覆盖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from '../server/store.js'
import { buildWriterPacket, renderWriterPacket, findLeaks } from '../server/projection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.MOBI_BASE || 'http://127.0.0.1:8787'
const OUT = path.resolve(__dirname, '..', 'docs')
const WRITE = !process.argv.includes('--no-write')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CONFIG = {
  idea: '1998 年秋天，我在城南邮局做临时分拣员。每天有一封没有寄件人的信从传送带上滑下来，'
    + '收件人写的是我的名字，可我从来没寄过信。我把它们收进抽屉，直到有一天邮戳变成了明天的日期。',
  genreTags: ['悬疑', '年代', '日常'],
  targetChapters: Number((process.argv.find((a) => a.startsWith('--chapters=')) || '').split('=')[1]) || 10,
  preferences: {
    protagonist: '一个刚从技校毕业、被分配到邮局分拣组的年轻人，第一人称。话少，手脚麻利，'
      + '习惯把疑问记在工牌背面而不是问出口。',
    style: '第一人称限知，中短句为主、长短交错。年代细节写实（铅字油墨味、分拣格口编号、'
      + '老式挂钟、铝饭盒、代销店的玻璃罐），情绪靠动作与环境承载，不写心理独白式抒情。对话短、留白多。',
    tone: '克制的年代悬疑，不神怪、不煽情。',
    pace: '一章一件小事推进一格：一封新信、一次盘问、一个不该记得我的人。每两三章漏一点真相。',
    ending: '他最终发现那些信是自己写给自己的，而邮戳的日期取决于他做出选择的先后。',
    forbidden: '禁止鬼怪与超自然解释；禁止出现真实公众人物；禁止露骨内容；禁止主角突然口若悬河。',
    coreGoal: '把那一抽屉没有寄件人的信查清楚，同时保住这份工作。',
  },
}

async function api(p, opt = {}) {
  const r = await fetch(BASE + p, { headers: { 'content-type': 'application/json' }, ...opt })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${r.status} ${data.error || ''}`)
  return data
}
// ⚠️ 字段名是**驼峰** `inputTokens/outputTokens`（不是 OpenAI 那套 prompt_tokens）。
//    这里同时兼容两种，避免再出现「花费显示 ¥0」的假绿。
const tok = (u) => ({
  i: u?.inputTokens ?? u?.prompt_tokens ?? u?.input_tokens ?? 0,
  o: u?.outputTokens ?? u?.completion_tokens ?? u?.output_tokens ?? 0,
})
const sumUsage = (usage = []) => usage.reduce((s, u) => { const t = tok(u); return { i: s.i + t.i, o: s.o + t.o } }, { i: 0, o: 0 })
const yuan = (s) => `¥${((s.i * 1 + s.o * 2) / 1e6).toFixed(4)}（输入 ${s.i} / 输出 ${s.o} tokens）`

/* ---------------- ① 开书 ---------------- */
console.log('① 开书（生成大纲 + 设定自动填充，约 40–90s）…')
const t0 = Date.now()
const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify(CONFIG) })
console.log(`   《${project.title}》 ${project.id} · ${project.targetChapters} 章 · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
const outline = project.outline || {}
console.log(`   实体 ${(project.entities || []).length} 个 · 伏笔 ${(outline.foreshadows || []).length} 条 · `
  + `卷 ${(outline.volumes || []).length} 个 · 首卷细化到第 ${outline.plannedDetailThrough || 0} 章`)

/* ---------------- ② 写第 1 章 ---------------- */
if (WRITE) {
  console.log('② 写第 1 章（真实模型调用）…')
  let { run } = await api(`/api/projects/${project.id}/runs`, { method: 'POST', body: JSON.stringify({ no: 1 }) })
  console.log('   run:', run.id)
  const done = ['committed', 'needs_input', 'awaiting_acceptance', 'failed', 'cancelled']
  for (let i = 0; i < 240; i++) {
    await sleep(2500)
    const { run: cur } = await api(`/api/runs/${run.id}`)
    if (done.includes(cur.status)) { run = cur; break }
  }
  if (run.status === 'awaiting_acceptance') {
    const r = await api(`/api/runs/${run.id}/accept`, { method: 'POST' })
    run = r.run || run
  }
  console.log(`   状态：${run.status} · 花费 ${yuan(sumUsage(run.usage))}`)
  if (run.status !== 'committed') console.log('   ⚠️ 没提交成功，第 2 章前情可能不完整：', run.error || run.status)
}

/* ---------------- ③ 导出第 2 章的上下文 ---------------- */
const fresh = store.getProject(project.id)
const packet = buildWriterPacket(fresh, 2)
const rendered = renderWriterPacket(packet)
const leaks = findLeaks(packet, fresh)

fs.mkdirSync(OUT, { recursive: true })
const base = `ch2-context-${fresh.id}`
fs.writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(packet, null, 2), 'utf8')
const md = [
  `# 第 2 章正文将要被喂的上下文 ·《${fresh.title}》`, '',
  `- 作品：\`${fresh.id}\`　目标 ${fresh.targetChapters} 章，`
    + `已定稿 ${(fresh.chapters || []).filter((c) => c.status === 'committed').length} 章`,
  `- 生成时间：${new Date().toISOString()}`,
  `- **泄漏自检：${leaks.length ? `未通过 ${leaks.length} 项` : '通过'}**`, '',
  '## 实际送往正文模型的提示词', '', '```text', rendered, '```', '',
  '## 结构化 packet（逐字段核对用）', '', '```json', JSON.stringify(packet, null, 2), '```', '',
].join('\n')
fs.writeFileSync(path.join(OUT, `${base}.md`), md, 'utf8')

console.log(`\n③ 已导出：\n   提示词 ${path.join(OUT, `${base}.md`)}\n   结构   ${path.join(OUT, `${base}.json`)}`)
console.log(`   泄漏自检：${leaks.length ? `未通过 ${leaks.length} 项` : '通过'}`)
console.log('\n================ 第 2 章正文提示词（原文） ================\n')
console.log(rendered)
console.log('\n================ 提示词结束 ================')
