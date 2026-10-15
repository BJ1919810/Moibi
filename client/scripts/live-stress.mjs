#!/usr/bin/env node
/**
 * 墨笔 v2 · 真实模型生成压力测试驱动
 *
 * 通过 HTTP 驱动后端，逐章生成并落 JSONL 记录。
 * 走的是与前端完全相同的 /runs + /accept 接口，不绕过任何提交门禁。
 *
 * 用法：
 *   # A) 简单：只给灵感+标签
 *   node scripts/live-stress.mjs --idea "一句话灵感" --tags 悬疑,都市 \
 *        --target 30 --from 1 --to 10 --out records/t1.jsonl
 *
 *   # B) 完整夹具：整份建作品 body（含 preferences）从文件读
 *   node scripts/live-stress.mjs --create scripts/t1-create.json \
 *        --from 1 --to 10 --out records/t1-chapters.jsonl
 *
 *   # C) 复用已有作品
 *   node scripts/live-stress.mjs --project p_xxxxxx --from 1 --to 10
 *
 * 选项：
 *   --base        后端地址（默认 http://127.0.0.1:8787）
 *   --token       访问口令（本机 127.0.0.1 免鉴权，可省）
 *   --project     复用已有作品 ID（p_xxx）；给了就不再新建
 *   --create      新建作品：读一份完整的 POST /api/projects body（JSON 文件，含 preferences）
 *   --idea        新建作品时的灵感（--project / --create 时忽略）
 *   --tags        逗号分隔的题材标签，如 悬疑,都市
 *   --prefs       新建作品：读一份 preferences JSON 文件附加到 body（配合 --idea）
 *   --target      目标章节数（默认 30）
 *   --from        起始章号（默认 1）
 *   --to          结束章号（默认 --from + 9）
 *   --out         JSONL 输出路径（默认 records/live-<时间戳>.jsonl）
 *   --in-rate     输入单价（货币/百万 token，默认 1）
 *   --out-rate    输出单价（货币/百万 token，默认 2）
 *   --poll        轮询间隔 ms（默认 2000）
 *   --timeout     单章上限 ms（默认 300000）
 *   --no-auto-accept  遇到风险章不自动接受，改为停下等待人工
 *   --dry-run     只打印计划，不发任何请求
 */

import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// ---------- 参数 ----------
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const key = k.slice(2)
    if (key === 'dry-run' || key === 'no-auto-accept') { a[key] = true; continue }
    a[key] = argv[++i]
  }
  return a
}
const args = parseArgs(process.argv.slice(2))

const BASE = args.base || 'http://127.0.0.1:8787'
const TOKEN = args.token || ''
const TAGS = (args.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
const TARGET = Number(args.target || 30)
const FROM = Number(args.from || 1)
const TO = Number(args.to || (FROM + 9))
const POLL = Number(args.poll || 2000)
const TIMEOUT = Number(args.timeout || 300000)
const AUTO_ACCEPT = !args['no-auto-accept']
const IN_RATE = Number(args['in-rate'] || 1)
const OUT_RATE = Number(args['out-rate'] || 2)
const DRY = !!args['dry-run']
const OUT = resolve(args.out || `records/live-${Date.now()}.jsonl`)

/** 终态：到此不再轮询 */
const TERMINAL = new Set(['committed', 'failed', 'cancelled', 'stale', 'needs_input', 'awaiting_acceptance'])

// ---------- HTTP ----------
async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'X-Mobi-Token': TOKEN } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 300) } }
  if (!res.ok) throw new Error(`${res.status} ${data.error || text.slice(0, 200)}`)
  return data
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 成本 ----------
function sumUsage(usage = [], rates = { inRate: IN_RATE, outRate: OUT_RATE }) {
  let input = 0, output = 0, reasoning = 0, cached = 0
  for (const u of usage) {
    input += Number(u.inputTokens) || 0
    output += Number(u.outputTokens) || 0
    reasoning += Number(u.reasoningTokens) || 0
    cached += Number(u.cachedInputTokens) || 0
  }
  const cost =
    ((input - cached) * rates.inRate + cached * rates.inRate * 0.1 + output * rates.outRate) / 1e6
  return { calls: usage.length, input, output, reasoning, cached, cost }
}

// ---------- 单章 ----------
async function waitRun(runId) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < TIMEOUT) {
    const { run } = await api(`/api/runs/${runId}`)
    last = run
    if (TERMINAL.has(run.status)) return run
    await sleep(POLL)
  }
  return { ...(last || {}), status: 'timeout', error: '轮询超时' }
}

async function runChapter(projectId, no) {
  const t0 = Date.now()
  const { run } = await api(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ no }),
  })
  let final = await waitRun(run.id)

  // 风险章（揭示秘密 / 回收伏笔）会停在 awaiting_acceptance
  let accepted = false
  if (final.status === 'awaiting_acceptance') {
    if (AUTO_ACCEPT) {
      const r = await api(`/api/runs/${final.id}/accept`, { method: 'POST' })
      final = r.run || final
      accepted = true
      // accept 后后端会继续提交，必要时再等一下
      if (!TERMINAL.has(final.status) || final.status === 'awaiting_acceptance') {
        final = await waitRun(final.id)
      }
    } else {
      console.warn(`  ⏸  第 ${no} 章停在待确认（风险章），未自动接受。runId=${final.id}`)
    }
  }

  const u = sumUsage(final.usage || [])
  return {
    no,
    status: final.status,
    step: final.step,
    durationMs: Date.now() - t0,
    usage: { calls: u.calls, input: u.input, output: u.output, reasoning: u.reasoning, cached: u.cached },
    estimatedCost: Number(u.cost.toFixed(6)),
    risk: final.plan?.chapterRisk ?? final.plan?.risk ?? 'normal',
    autoAccepted: accepted,
    cast: final.manifest?.cast || final.plan?.cast || [],
    foreshadowActions: (final.plan?.foreshadows || []).map((f) => `${f.action}:${f.id || f.threadId || ''}`),
    headVersion: final.headVersion ?? null,
    bodyChars: String(final.draft?.text || '').replace(/\s/g, '').length,
    error: final.error || null,
    note: '',
  }
}

// ---------- 主流程 ----------
async function main() {
  // 组装「新建作品」的 body（--project 时不需要）
  let createBody = null
  if (!args.project) {
    if (args.create) {
      createBody = JSON.parse(readFileSync(resolve(args.create), 'utf8'))
    } else if (args.idea) {
      createBody = { idea: args.idea, genreTags: TAGS, targetChapters: TARGET }
      if (args.prefs) {
        createBody.preferences = JSON.parse(readFileSync(resolve(args.prefs), 'utf8'))
      }
    }
  }
  const prefKeys = Object.keys(createBody?.preferences || {})

  console.log('==============================================')
  console.log(' 墨笔 v2 · 真实模型压力测试驱动')
  console.log('==============================================')
  console.log(`  后端      : ${BASE}`)
  console.log(`  章节区间  : 第 ${FROM} → ${TO} 章`)
  console.log(`  单价      : 输入 ${IN_RATE} / 输出 ${OUT_RATE}（每百万 token）`)
  console.log(`  自动接受  : ${AUTO_ACCEPT}`)
  console.log(`  输出      : ${OUT}`)
  if (args.project) console.log(`  复用作品  : ${args.project}`)
  else if (createBody) {
    console.log(`  新建作品  : 标签=[${(createBody.genreTags || []).join(',')}]  目标 ${createBody.targetChapters || 30} 章  偏好 ${prefKeys.length} 项`)
    console.log(`  灵感      : ${String(createBody.idea || '').slice(0, 48)}${String(createBody.idea || '').length > 48 ? '…' : ''}`)
    if (prefKeys.length) console.log(`  偏好字段  : ${prefKeys.join(', ')}`)
  } else console.log('  新建作品  : (未提供 --idea / --create)')
  console.log('')

  if (DRY) { console.log('（--dry-run：未发送任何请求）'); return }

  // 健康检查
  const health = await api('/api/health')
  console.log(`✓ 服务在线：${JSON.stringify(health).slice(0, 160)}`)

  // 取/建作品
  let projectId = args.project
  if (!projectId) {
    if (!createBody) throw new Error('新建作品必须提供 --idea（或 --create <body.json>）')
    console.log('→ 创建作品并生成全书大纲（可能需 30–90 秒）…')
    const t0 = Date.now()
    const { project, warning } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify(createBody),
    })
    if (warning) console.warn(`  ⚠ 大纲生成告警：${warning}`)
    projectId = project.id
    const outline = project.outline || []
    console.log(`✓ 作品 ${projectId} ｜ 大纲 ${outline.length} 章 ｜ 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    if (project.foreshadows?.length) {
      console.log(`  伏笔 ${project.foreshadows.length} 条：` +
        project.foreshadows.slice(0, 6).map((f) => `${f.id || f.title}(${f.seedCh ?? f.seed ?? '?'}→${f.payoffCh ?? f.payoff ?? '?'})`).join(', '))
    }
  } else {
    const { project } = await api(`/api/projects/${projectId}`)
    console.log(`✓ 复用作品 ${projectId} ｜ ${project.title || '(无题)'} ｜ 已提交 ${(project.chapters || []).filter((c) => c.status === 'committed').length} 章`)
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, '')

  // 逐章
  const t0 = Date.now()
  let totalCost = 0, totalIn = 0, totalOut = 0, okCount = 0, badCount = 0
  for (let no = FROM; no <= TO; no++) {
    process.stdout.write(`→ 第 ${no} 章 … `)
    let rec
    try {
      rec = await runChapter(projectId, no)
    } catch (e) {
      rec = { no, status: 'request_error', error: String(e.message || e), durationMs: 0, estimatedCost: 0 }
    }
    appendFileSync(OUT, JSON.stringify(rec) + '\n')

    const flag = rec.status === 'committed' ? '✓' : '✗'
    if (rec.status === 'committed') { okCount++; totalCost += rec.estimatedCost; totalIn += rec.usage?.input || 0; totalOut += rec.usage?.output || 0 }
    else badCount++
    console.log(`${flag} ${rec.status}  ${(rec.durationMs / 1000).toFixed(1)}s  ` +
      `in=${rec.usage?.input ?? '-'} out=${rec.usage?.output ?? '-'}  ` +
      `¥${(rec.estimatedCost ?? 0).toFixed(4)}  risk=${rec.risk}` +
      (rec.error ? `  err=${rec.error}` : ''))

    if (rec.status === 'needs_input' || rec.status === 'stale') {
      console.warn(`  ⚠ 第 ${no} 章需要人工介入（${rec.status}）——按设计停止，避免重复扣费。`)
      break
    }
  }

  console.log('')
  console.log('================ 汇总 ================')
  console.log(`  成功提交 : ${okCount} 章` + (badCount ? `  ｜ 异常 ${badCount} 章` : ''))
  console.log(`  总耗时   : ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`  总 token : 输入 ${totalIn} / 输出 ${totalOut}`)
  console.log(`  总花费   : ¥${totalCost.toFixed(4)}` + (okCount ? `  （均 ¥${(totalCost / okCount).toFixed(4)}/章）` : ''))
  console.log(`  记录文件 : ${OUT}`)
}

main().catch((e) => { console.error('\n✗ 失败：', e.message || e); process.exit(1) })
