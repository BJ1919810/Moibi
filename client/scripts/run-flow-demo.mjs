#!/usr/bin/env node
/**
 * 全流程演示：**开书 → 顺写 N 章 → 导出下一章的上下文 → 汇总各机制的证据**。
 *
 * 与 `demo-second-chapter-context.mjs` 的区别：这个脚本走**完整的连写**（含每章的
 * 规划 → 写作 → 记忆抽取 → 提交），并在结尾把「计划/账本/伏笔/门禁/花费」一并摊开，
 * 用来一次性验收整条链路。生成过程逐章落盘，中途失败也不丢已提交的章节。
 *
 * 用法：node scripts/run-flow-demo.mjs [章节数] [--config=路径.json]
 *   ⚠️ 真实模型调用：开书约 ¥0.01，每章约 ¥0.011。默认写 2 章。
 *   ⚠️ 需要服务在跑（默认 http://127.0.0.1:8787，用 MOBI_BASE 覆盖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from '../server/store.js'
import { buildWriterPacket, renderWriterPacket, findLeaks } from '../server/projection.js'
import { auditWriterSummaries, outlineAuditNotes } from '../server/pipeline.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.MOBI_BASE || 'http://127.0.0.1:8787'
const OUT = path.resolve(__dirname, '..', 'docs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argv = process.argv.slice(2)
const CHAPTERS = Number(argv.find((a) => /^\d+$/.test(a))) || 2
const cfgArg = (argv.find((a) => a.startsWith('--config=')) || '').split('=')[1]

const CONFIG = cfgArg
  ? JSON.parse(fs.readFileSync(path.resolve(cfgArg), 'utf8'))
  : {
      idea: '我在市博物馆的古埃及展厅看一尊石猫雕像时晕了过去。醒来时躺在医院，医生说只是低血糖。'
        + '但我的左眼变了：闭上右眼，我能看见三秒后的画面——护士下一秒会转身、走廊尽头有人在打电话、'
        + '我自己三秒后会看向窗外。三秒很短，短到只能救一个人、只能躲一次、只能看清一样东西。'
        + '出院那天，新闻说那尊石猫雕像在闭馆后不见了，而监控里最后一个碰过它的人，是我。',
      genreTags: ['都市', '悬疑', '超能力'],
      targetChapters: 12,
      preferences: {
        protagonist: '26 岁社区图书馆管理员，第一人称。习惯把不确定的事记在小本子上，不擅长开口求助；'
          + '对超自然的第一反应是「先验证再说」，而不是惊慌。',
        style: '第一人称限知，中短句为主、长短交错。能力只写**可观察的画面**（形状、动作、声音、温度），'
          + '绝不解释原理，也不做设定说明；紧张处用短句与留白，日常处放慢写细节（书脊的胶味、'
          + '借书卡的毛边、医院走廊的消毒水味）。对话短、信息密度高。',
        tone: '克制的都市悬疑：不中二、不升华、不煽情，允许一点冷幽默。',
        pace: '一章一件小事推进一格：一次验证、一次误判、一次代价。每两三章漏一点来历的真相。',
        ending: '他最终发现那三秒看到的从来不是「未来」，而是自己做过选择之后留下的痕迹。',
        forbidden: '禁止系统流／面板／签到／属性数值／任务提示音；禁止无代价地滥用能力'
          + '（每次使用都要有可观察的代价，例如头痛、耳鸣、短暂看不清）；禁止露骨内容；'
          + '禁止出现真实公众人物。',
        coreGoal: '查清那只眼睛的来历，同时把自己从「石猫雕像失窃案」里摘干净。',
      },
    }

async function api(p, opt = {}) {
  const r = await fetch(BASE + p, { headers: { 'content-type': 'application/json' }, ...opt })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${r.status} ${data.error || ''}`)
  return data
}
const tok = (u) => ({ i: u?.inputTokens ?? 0, o: u?.outputTokens ?? 0 })
const sumUsage = (usage = []) => usage.reduce((s, u) => { const t = tok(u); return { i: s.i + t.i, o: s.o + t.o } }, { i: 0, o: 0 })
const yuan = (s) => `¥${((s.i * 1 + s.o * 2) / 1e6).toFixed(4)}`
const DONE = ['committed', 'needs_input', 'awaiting_acceptance', 'failed', 'cancelled']

/** 写一章并等到落地；返回最终 run */
async function writeChapter(projectId, no) {
  let { run } = await api(`/api/projects/${projectId}/runs`, { method: 'POST', body: JSON.stringify({ no }) })
  for (let i = 0; i < 240; i++) {
    await sleep(2500)
    const { run: cur } = await api(`/api/runs/${run.id}`)
    if (DONE.includes(cur.status)) { run = cur; break }
  }
  if (run.status === 'awaiting_acceptance') {
    const r = await api(`/api/runs/${run.id}/accept`, { method: 'POST' })
    run = r.run || run
  }
  return run
}

/* ---------------- ① 开书 ---------------- */
console.log('① 开书（大纲 + 设定自动填充，约 30–90s）…')
const t0 = Date.now()
const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify(CONFIG) })
console.log(`   《${project.title}》 ${project.id} · 目标 ${project.targetChapters} 章 · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
const o0 = project.outline || {}
console.log(`   实体 ${(project.entities || []).length} · 伏笔 ${(o0.foreshadows || []).length} · 卷 ${(o0.volumes || []).length} · 首卷细化到第 ${o0.plannedDetailThrough || 0} 章`)

/* ---------------- ② 连写 ---------------- */
let total = { i: 0, o: 0 }
for (let no = 1; no <= CHAPTERS; no++) {
  console.log(`② 写第 ${no} 章…`)
  const run = await writeChapter(project.id, no)
  const u = sumUsage(run.usage); total.i += u.i; total.o += u.o
  const fresh = store.getProject(project.id)
  const ch = (fresh.chapters || []).find((c) => c.no === no)
  console.log(`   状态 ${run.status} · ${yuan(u)} · 正文 ${ch ? String(ch.text || '').replace(/\s/g, '').length : 0} 字`
    + ` · 摘要 ${(ch?.summary || '').slice(0, 40)}`)
  if (run.status !== 'committed') { console.log('   ⚠️ 未提交，停止连写：', run.error || run.status); break }
}

/* ---------------- ③ 汇总证据 ---------------- */
const p = store.getProject(project.id)
const chs = (p.chapters || []).filter((c) => c.status === 'committed')
console.log('\n③ 结果汇总')
console.log(`   已定稿 ${chs.length} 章 · 合计 ${yuan(total)}（输入 ${total.i} / 输出 ${total.o} tokens）`)
console.log(`   账本：事实 ${(p.ledger?.canonicalFacts || []).length} · 状态 ${(p.ledger?.currentState || []).length}`
  + ` · 认知 ${(p.ledger?.characterKnowledge || []).length} · 线索 ${(p.ledger?.plotThreads || []).length}`
  + ` · 伏笔事件 ${(p.ledger?.foreshadowEvents || []).length}`)
const meta = (p.outline?.volumes || []).flatMap((v) => v.chapters || []).find((c) => c.no === chs.length + 1)
console.log(`   下一章（第 ${chs.length + 1} 章）计划：${meta?.title || '（无）'} · 任务批准状态 ${meta?.writerTaskApproval || '—'}`)

const audit = auditWriterSummaries(p.outline?.volumes || [], p.outline?.foreshadows || [], p)
const notes = outlineAuditNotes(audit, p)
console.log(`   概要审查：${audit.length ? `${audit.length} 条（${notes[0].slice(0, 60)}…）` : '无告警 ✅'}`)

const nextNo = chs.length + 1
let packet = null; let leaks = []
try {
  packet = buildWriterPacket(p, nextNo)
  leaks = findLeaks(packet, p)
} catch (e) {
  console.log(`   ⚠️ 第 ${nextNo} 章投影被门禁拦下（这是设计）：${e.message}`)
}
if (packet) {
  const rendered = renderWriterPacket(packet)
  fs.mkdirSync(OUT, { recursive: true })
  const base = `flow-${p.id}-ch${nextNo}`
  fs.writeFileSync(path.join(OUT, `${base}.md`),
    `# 全流程演示 ·《${p.title}》第 ${nextNo} 章正文将收到的上下文\n\n`
    + `- 已定稿 ${chs.length}/${p.targetChapters} 章 · 生成时间 ${new Date().toISOString()}\n`
    + `- 泄漏自检：${leaks.length ? `未通过 ${leaks.length} 项` : '通过'}\n\n`
    + '```text\n' + rendered + '\n```\n', 'utf8')
  console.log(`   泄漏自检：${leaks.length ? `未通过 ${leaks.length} 项` : '通过 ✅'}`)
  console.log(`   下一章上下文已导出：${path.join(OUT, `${base}.md`)}`)
}
console.log(`\n作品 ID：${p.id}（网页版 http://127.0.0.1:8787 可继续写/阅读）`)
