#!/usr/bin/env node
/**
 * 墨笔 v2 · 「胡来」全量压力测试（End-to-End Chaos）
 *
 * 目标：把主人要的测试性操作全跑一遍，尽量节省 token。
 *   ① 开书（含自动填充）
 *   ② 逐章写正文（含风险章 awaiting_acceptance 自动接受）
 *   ③ 中途「细化下一组 5 章」（滚动窗口）
 *   ④ 中途改设定（角色改名 / 世界观 / 剧情方向 / 主题）并观察重排
 *   ⑤ 故意胡来：越界章号、重复提交、空请求、改到不存在的角色…
 *   ⑥ 边写边改（先写几章 → 改设定 → 触发 pendingReplan → 重排 → 继续写）
 *
 * **省 token 的硬约定**：
 *   · 所有「胡来」操作都走**不改数据**的路径（非法请求期望被服务端拒绝），
 *     拒绝发生在模型调用**之前** ⇒ 零成本。
 *   · 只有 ①②③④⑥ 会真花钱，且每章只花一次。
 *   · `--dry-run` 可先看计划。
 *
 * 用法：
 *   node scripts/chaos-full-book.mjs --idea "..." --target 30
 *   node scripts/chaos-full-book.mjs --create scripts/t1-create.json --target 30
 *   node scripts/chaos-full-book.mjs --project p_xxx --from 1 --to 30
 *   node scripts/chaos-full-book.mjs --create ... --plan-only   # 只打印计划
 */
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/* ------------------------------ 参数 ------------------------------ */
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const key = k.slice(2)
    if (['dry-run', 'plan-only', 'no-auto-accept', 'no-chaos'].includes(key)) { a[key] = true; continue }
    a[key] = argv[++i]
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const BASE = args.base || 'http://127.0.0.1:8787'
const TOKEN = args.token || ''
const TARGET = Number(args.target || 30)
const FROM = Number(args.from || 1)
const TO = Number(args.to || TARGET)
const POLL = Number(args.poll || 2000)
const TIMEOUT = Number(args.timeout || 300000)
const AUTO_ACCEPT = !args['no-auto-accept']
const DRY = !!args['dry-run'] || !!args['plan-only']
const CHAOS = !args['no-chaos']
const IN_RATE = Number(args['in-rate'] || 1)
const OUT_RATE = Number(args['out-rate'] || 2)
const OUT = resolve(args.out || `records/chaos-${Date.now()}.jsonl`)
const SUMMARY = resolve(args.summary || `records/chaos-${Date.now()}-summary.json`)

const TERMINAL = new Set(['committed', 'failed', 'cancelled', 'stale', 'needs_input', 'awaiting_acceptance'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 记账 ------------------------------ */
const log = []
function note(kind, text, extra = {}) {
  const rec = { t: new Date().toISOString(), kind, text, ...extra }
  log.push(rec)
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  return rec
}

/* ------------------------------ HTTP ------------------------------ */
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
  return { status: res.status, ok: res.ok, data }
}
/** 期望成功的调用 */
async function apiOk(path, options) {
  const r = await api(path, options)
  if (!r.ok) throw new Error(`${r.status} ${r.data.error || ''}`)
  return r.data
}

function sumUsage(usage = []) {
  let input = 0, output = 0, reasoning = 0, cached = 0, calls = 0
  for (const u of usage) {
    calls++
    input += Number(u.inputTokens) || 0
    output += Number(u.outputTokens) || 0
    reasoning += Number(u.reasoningTokens) || 0
    cached += Number(u.cachedInputTokens) || 0
  }
  const cost = ((input - cached) * IN_RATE + cached * IN_RATE * 0.1 + output * OUT_RATE) / 1e6
  return { calls, input, output, reasoning, cached, cost }
}

/* ------------------------------ 任务等待 ------------------------------ */
async function waitRun(runId, label = '') {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < TIMEOUT) {
    const { data } = await api(`/api/runs/${runId}`)
    last = data.run
    if (!last) return { status: 'missing', error: '任务不存在' }
    if (TERMINAL.has(last.status)) return last
    await sleep(POLL)
  }
  return { ...(last || {}), status: 'timeout', error: `轮询超时（${TIMEOUT}ms）` }
}

/* ------------------------------ 操作：写一章 ------------------------------ */
async function writeChapter(projectId, no) {
  const t0 = Date.now()
  const { data } = await api(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ no }),
  })
  if (!data.run) return { no, status: 'request_error', error: data.error || '无 run 返回', durationMs: 0 }
  let final = await waitRun(data.run.id)
  let accepted = false
  if (final.status === 'awaiting_acceptance' && AUTO_ACCEPT) {
    const r = await api(`/api/runs/${final.id}/accept`, { method: 'POST' })
    final = r.data.run || final
    accepted = true
    if (!TERMINAL.has(final.status) || final.status === 'awaiting_acceptance') final = await waitRun(final.id)
  }
  const u = sumUsage(final.usage || [])
  return {
    no, status: final.status, step: final.step, risk: final.plan?.chapterRisk ?? final.plan?.risk ?? 'normal',
    durationMs: Date.now() - t0, autoAccepted: accepted,
    input: u.input, output: u.output, reasoning: u.reasoning, calls: u.calls,
    cost: Number(u.cost.toFixed(6)),
    bodyChars: String(final.draft?.text || '').replace(/\s/g, '').length,
    unresolvedSubjects: final.unresolvedSubjects || [],
    warnings: final.warnings || [],
    error: final.error || null,
  }
}

/* ------------------------------ 操作：细化下一组 ------------------------------ */
async function detailWindow(projectId, label = '') {
  const t0 = Date.now()
  const { data } = await api(`/api/projects/${projectId}/replan`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'window' }),
  })
  if (!data.run) return { status: 'request_error', error: data.error || '无 run 返回', durationMs: 0 }
  const final = await waitRun(data.run.id)
  const u = sumUsage(final.usage || [])
  return {
    label, status: final.status, step: final.step, durationMs: Date.now() - t0,
    input: u.input, output: u.output, cost: Number(u.cost.toFixed(6)),
    warnings: final.warnings || [], error: final.error || null,
  }
}

/* ------------------------------ 操作：重排（全局） ------------------------------ */
/**
 * 改设定会把 pendingReplan 置位，此时**所有**正文生成都会被拦
 * （workflow.createRun 第 143 行）。解锁的唯一出路是跑一次 `mode='full'` 的重排
 * （replan.js 第 274 行：没有 pendingReplan 时反而会拒绝 full）。
 * 界面上对应「重排尚未定稿章节（调用模型）」按钮。
 */
async function replanFull(projectId, label = '') {
  const t0 = Date.now()
  const { data } = await api(`/api/projects/${projectId}/replan`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'full' }),
  })
  if (!data.run) return { label, status: 'request_error', error: data.error || '无 run 返回', durationMs: 0, cost: 0 }
  // 「没有待重排的篇幅或剧情」是合法拒绝（本来就不需要重排），不算失败
  const final = await waitRun(data.run.id)
  const u = sumUsage(final.usage || [])
  return {
    label, status: final.status, step: final.step, durationMs: Date.now() - t0,
    input: u.input, output: u.output, cost: Number(u.cost.toFixed(6)),
    warnings: final.warnings || [], error: final.error || null,
  }
}

/* ------------------------------ 操作：改设定（走 change-request） ------------------------------ */
/** 创建预览 → 批准。返回 {status, error, detail}。零成本（不调模型） */
async function changeSetting(projectId, change, { approve = true } = {}) {
  const c = await api(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    body: JSON.stringify(change),
  })
  if (!c.ok) return { status: c.status, error: c.data.error || '创建失败', approved: false }
  const cr = c.data.request
  if (!approve) return { status: 201, requestId: cr?.id, approved: false, impact: cr?.impact || null }
  const a = await api(`/api/changes/${cr.id}/approve`, { method: 'POST' })
  return {
    status: a.status, ok: a.ok, requestId: cr.id, approved: a.ok,
    impact: cr?.impact || null, error: a.data?.error || null,
  }
}

/* ------------------------------ 胡来用例（全部零成本） ------------------------------ */
async function runChaos(projectId, curNo) {
  const results = []
  const T = async (name, fn) => {
    try {
      const r = await fn()
      results.push({ name, ...r })
      const flag = r.expected === r.got ? '✓' : '⚠'
      note('chaos', `${flag} ${name} → 期望 ${r.expected}，实际 ${r.got}${r.hint ? `（${r.hint}）` : ''}`, r)
    } catch (e) {
      results.push({ name, error: String(e.message || e) })
      note('chaos', `✗ ${name} 抛错：${e.message || e}`, { error: String(e.message || e) })
    }
  }
  const P = (path, options) => api(path, options)

  // 1) 写一个不存在的巨大章号 —— 期望被服务端拦下（不花钱）
  await T('越界章号（9999）', async () => {
    const r = await P(`/api/projects/${projectId}/runs`, { method: 'POST', body: JSON.stringify({ no: 9999 }) })
    return { expected: '拒绝', got: r.ok ? '接受' : `${r.status}`, hint: r.data.error }
  })
  // 2) 写第 0 章 / 负数
  await T('非法章号（0）', async () => {
    const r = await P(`/api/projects/${projectId}/runs`, { method: 'POST', body: JSON.stringify({ no: 0 }) })
    return { expected: '拒绝或回退到下一章', got: r.ok ? `接受(no=${r.data.run?.chapterNo ?? r.data.run?.no})` : `${r.status}` }
  })
  // 3) 改写已定稿章节（应被 CAS/版本线拦下或标记 stale）
  await T('重写已定稿章节（1）', async () => {
    const r = await P(`/api/projects/${projectId}/runs`, { method: 'POST', body: JSON.stringify({ no: 1 }) })
    if (!r.ok) return { expected: '拒绝', got: `${r.status}`, hint: r.data.error }
    const fin = await waitRun(r.data.run.id)
    return { expected: '拒绝或 stale', got: fin.status, hint: fin.error }
  })
  // 4) 引用不存在的角色改设定
  await T('改不存在角色的字段', async () => {
    const r = await P(`/api/projects/${projectId}/changes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'character_field', entityId: 'ent_不存在', field: 'personality', value: '胡来' }),
    })
    return { expected: '拒绝(409)', got: `${r.status}`, hint: r.data.error }
  })
  // 5) 改不允许编辑的角色字段
  await T('改非法角色字段（id）', async () => {
    const { data } = await P(`/api/projects/${projectId}`)
    const ent = (data.project?.entities || [])[0]
    if (!ent) return { expected: '拒绝', got: '无角色可测', hint: '跳过' }
    const r = await P(`/api/projects/${projectId}/changes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'character_field', entityId: ent.id, field: 'id', value: 'x' }),
    })
    return { expected: '拒绝(409)', got: `${r.status}`, hint: r.data.error }
  })
  // 6) 超长修改内容（>1200 字）
  await T('超长修改内容（2000字）', async () => {
    const { data } = await P(`/api/projects/${projectId}`)
    const ent = (data.project?.entities || [])[0]
    if (!ent) return { expected: '拒绝', got: '无角色可测', hint: '跳过' }
    const r = await P(`/api/projects/${projectId}/changes`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'character_field', entityId: ent.id, field: 'personality', value: '胡'.repeat(2000) }),
    })
    return { expected: '拒绝(409)', got: `${r.status}`, hint: r.data.error }
  })
  // 7) 空 body
  await T('空 body 建任务', async () => {
    const r = await P(`/api/projects/${projectId}/runs`, { method: 'POST', body: JSON.stringify({}) })
    if (!r.ok) return { expected: '拒绝', got: `${r.status}` }
    const fin = await waitRun(r.data.run.id)
    return { expected: '回退到下一章并可提交', got: fin.status, hint: `no=${r.data.run.chapterNo ?? '?'}` }
  })
  // 8) 不存在的作品
  await T('操作不存在的作品', async () => {
    const r = await P('/api/projects/p_不存在/runs', { method: 'POST', body: JSON.stringify({ no: 1 }) })
    return { expected: '拒绝(404)', got: `${r.status}` }
  })
  // 9) 直接写作者侧字段（已废弃接口，应 410）
  await T('直接写 author-settings（废弃接口）', async () => {
    const r = await P(`/api/projects/${projectId}/author-settings`, { method: 'POST', body: JSON.stringify({ coreGoal: '胡来' }) })
    return { expected: '拒绝(410)', got: `${r.status}`, hint: r.data.error }
  })
  // 10) 批准一个不存在的修改请求
  await T('批准不存在的修改请求', async () => {
    const r = await P('/api/changes/cr_000000000000000000000000/approve', { method: 'POST' })
    return { expected: '拒绝(404/409)', got: `${r.status}`, hint: r.data.error }
  })

  const passed = results.filter((r) => !r.error).length
  note('chaos-summary', `胡来用例 ${results.length} 项，未抛错 ${passed} 项`, { results })
  return results
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  let createBody = null
  if (!args.project) {
    if (args.create) createBody = JSON.parse(readFileSync(resolve(args.create), 'utf8'))
    else if (args.idea) createBody = { idea: args.idea, genreTags: (args.tags || '').split(/[,，]/).filter(Boolean), targetChapters: TARGET }
  }

  console.log('==========================================================')
  console.log(' 墨笔 v2 · 「胡来」全量压力测试')
  console.log('==========================================================')
  console.log(`  后端     : ${BASE}`)
  console.log(`  章节区间 : 第 ${FROM} → ${TO} 章（目标 ${TARGET} 章）`)
  console.log(`  自动接受 : ${AUTO_ACCEPT}`)
  console.log(`  胡来用例 : ${CHAOS ? '开' : '关'}`)
  console.log(`  记录     : ${OUT}`)
  console.log(`  汇整     : ${SUMMARY}`)
  if (args.project) console.log(`  复用作品 : ${args.project}`)
  else if (createBody) console.log(`  新建     : 标签=[${(createBody.genreTags || []).join(',')}] 目标 ${createBody.targetChapters || 30} 章`)
  console.log('')

  if (DRY) { console.log('（--dry-run：未发送任何请求）'); return }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, '')
  const events = { create: null, detailWindows: [], changes: [], chapters: [], chaos: [], replans: [] }

  /* 健康检查 */
  const health = await apiOk('/api/health')
  console.log(`✓ 服务在线：${JSON.stringify(health).slice(0, 120)}`)

  /* ---- ① 开书 ---- */
  let projectId = args.project
  if (!projectId) {
    if (!createBody) throw new Error('需提供 --idea 或 --create')
    console.log('\n① 开书（生成全书大纲 + 自动填充，约 40–90s）…')
    const t0 = Date.now()
    const { data, ok: isOk, status } = await api('/api/projects', { method: 'POST', body: JSON.stringify(createBody) })
    if (!isOk) {
      note('create-failed', `开书失败 ${status}：${data.error || ''}`, { status })
      throw new Error(`开书失败 ${status} ${data.error || ''}`)
    }
    projectId = data.project.id
    const outline = data.project.outline || {}
    const volumes = outline.volumes || []
    events.create = {
      projectId, durationMs: Date.now() - t0, warning: data.warning || null,
      title: data.project.title,
      status: data.project.status,
      outlineError: data.project.outlineError || null,
      volumes: volumes.length,
      target: outline.totalChapters,
      detailThrough: outline.plannedDetailThrough,
      foreshadows: (outline.foreshadows || []).length,
      entities: (data.project.entities || []).length,
      outlineNotes: data.project.outlineNotes || [],
      autoFilled: {
        world: !!data.project.authorWorldRules,
        coreGoal: !!data.project.preferences?.coreGoal,
        styleSpec: !!data.project.preferences?.styleSpec,
      },
    }
    const c = events.create
    // ⚠️ 开书 API 即使大纲生成失败也返回 201（作品壳已建），所以**不能只看 HTTP 状态**。
    // 之前这里无条件打 ✓，导致 401 失败被显示成「开书成功 0 卷 / 目标 undefined 章」。
    // 判据必须落到**产物**上：有没有卷。
    if (!volumes.length) {
      const why = c.outlineError || c.warning || '未知原因'
      console.log(`✗ 开书失败：作品 ${projectId} 已建壳但大纲为空`)
      console.log(`   status=${c.status} ｜ 原因：${String(why).slice(0, 200)}`)
      note('create-failed', `开书产不出大纲：${String(why).slice(0, 160)}`, c)
      throw new Error(`开书失败（大纲为空）：${String(why).slice(0, 200)}`)
    }
    console.log(`✓ 开书 ${projectId} ｜《${c.title}》｜ ${c.volumes} 卷 / 目标 ${c.target} 章 ｜ 已细化到第 ${c.detailThrough} 章 ｜ ${((c.durationMs) / 1000).toFixed(1)}s`)
    console.log(`  实体 ${c.entities} ｜ 伏笔 ${c.foreshadows} ｜ 自动填充 world=${c.autoFilled.world} coreGoal=${c.autoFilled.coreGoal} styleSpec=${c.autoFilled.styleSpec}`)
    if (c.warning) console.warn(`  ⚠ ${c.warning}`)
    if (c.outlineNotes.length) console.warn(`  ⚠ 概要审查：${c.outlineNotes.length} 条`)
    note('create', `开书成功《${c.title}》${c.volumes}卷/目标${c.target}章`, c)
    if (data.project.outline?.summaryAudit?.length) {
      note('outline-audit', `开书阶段概要审查命中 ${data.project.outline.summaryAudit.length} 条`, data.project.outline.summaryAudit)
    }
  } else {
    const { project } = await apiOk(`/api/projects/${projectId}`)
    console.log(`✓ 复用 ${projectId}｜《${project.title}》｜已定稿 ${(project.chapters || []).filter((c) => c.status === 'committed').length} 章`)
  }

  /* ---- ② 逐章写正文（中途插入 ③ 细化 与 ④ 改设定）---- */
  console.log('\n② 逐章执笔' + (CHAOS ? '（第 3 章后先跑一轮「胡来」用例）' : '') + ' …')
  const t0 = Date.now()
  let ok = 0, bad = 0, cost = 0, inTok = 0, outTok = 0
  let windowDone = false
  let changeDone = false

  for (let no = FROM; no <= TO; no++) {
    /* --- ④ 中途改设定：在第 4 章之前 --- */
    if (CHAOS && !changeDone && no === 4) {
      changeDone = true
      console.log('\n④ 中途改设定（写了几章后改角色/世界观/剧情方向）…')
      const { project } = await apiOk(`/api/projects/${projectId}`)
      const ents = project.entities || []
      const target = ents[0]
      if (target) {
        const r1 = await changeSetting(projectId, {
          kind: 'character_field', entityId: target.id, field: 'personality',
          value: '（压力测试改写）性子比原先更执拗，遇事先动手再解释。',
        })
        events.changes.push({ what: '角色性格', ...r1 })
        console.log(`  改角色「${target.name}」性格 → ${r1.approved ? '已批准' : r1.error || '未批准'}${r1.impact ? ` ｜ 影响：${JSON.stringify(r1.impact).slice(0, 100)}` : ''}`)
        note('change', `改角色性格 ${r1.approved ? 'OK' : '失败'}`, r1)

        const r2 = await changeSetting(projectId, {
          kind: 'rename', entityId: target.id, value: `${target.name}改`,
        })
        events.changes.push({ what: '角色改名', ...r2 })
        console.log(`  改角色名「${target.name}」→「${target.name}改」 ${r2.approved ? '已批准' : r2.error || '未批准'}`)
        note('change', `改角色名 ${r2.approved ? 'OK' : '失败'}`, r2)

        // 改回来，避免后面正文里名字对不上影响观察
        const r2b = await changeSetting(projectId, { kind: 'rename', entityId: target.id, value: target.name })
        console.log(`  改回原名 ${r2b.approved ? '已批准' : r2b.error || '未批准'}`)
      }
      const r3 = await changeSetting(projectId, {
        kind: 'plot_direction', value: '（压力测试）中段必须出现一次立场反转，原盟友短暂对立后和解。',
      })
      events.changes.push({ what: '剧情方向', ...r3 })
      console.log(`  改剧情方向 → ${r3.approved ? '已批准' : r3.error || '未批准'}${r3.impact ? ` ｜ ${JSON.stringify(r3.impact).slice(0, 100)}` : ''}`)
      note('change', `改剧情方向 ${r3.approved ? 'OK' : '失败'}`, r3)

      const r4 = await changeSetting(projectId, { kind: 'world', value: '（压力测试）这个世界里，所有正式约定都以口头承诺生效，书面契约反而无效。' })
      events.changes.push({ what: '世界观', ...r4 })
      console.log(`  改世界观 → ${r4.approved ? '已批准' : r4.error || '未批准'}`)
      note('change', `改世界观 ${r4.approved ? 'OK' : '失败'}`, r4)

      const { project: after } = await apiOk(`/api/projects/${projectId}`)
      console.log(`  改后状态：pendingReplan=${!!after.pendingReplan}  editRevision=${after.editRevision}`)
      note('change-state', `改设定后 pendingReplan=${!!after.pendingReplan}`, { pendingReplan: !!after.pendingReplan, editRevision: after.editRevision })

      /* 改设定把 pendingReplan 置位 ⇒ 后续正文全部被拦。必须跑一次全局重排解锁
         （这正是界面上「重排尚未定稿章节（调用模型）」按钮做的事）。
         不跑这一步，剩下的 26 章会在模型调用前全部被拒 —— 一分钱都花不出去，
         也就测不到任何生成逻辑。 */
      if (after.pendingReplan) {
        console.log('\n④b 全局重排（解锁 pendingReplan）…')
        const rp = await replanFull(projectId, 'after-change')
        events.replans.push(rp)
        const flag = rp.status === 'committed' ? '✓' : '✗'
        console.log(`  ${flag} 重排 ${rp.status} ｜ ${(rp.durationMs / 1000).toFixed(1)}s ｜ ¥${(rp.cost || 0).toFixed(4)}${rp.error ? ` ｜ err=${rp.error}` : ''}`)
        cost += rp.cost || 0
        note('replan-full', `全局重排 ${rp.status}`, rp)
        const { project: freed } = await apiOk(`/api/projects/${projectId}`)
        console.log(`  重排后 pendingReplan=${!!freed.pendingReplan}（应为 false，否则后面写不了）`)
        if (freed.pendingReplan) {
          console.warn('  ⚠ 重排没能解锁 pendingReplan，后续章节会被拦。')
          note('replan-stuck', '重排后 pendingReplan 仍为 true', { pendingReplan: true })
        }
      }
    }

    /* --- ③ 细化下一组（在开头几章之后触发一次）--- */
    if (CHAOS && !windowDone && no === 3) {
      windowDone = true
      console.log('\n③ 细化下一组（滚动窗口，最多 5 章）…')
      const r = await detailWindow(projectId, 'mid-book')
      events.detailWindows.push(r)
      const flag = r.status === 'committed' ? '✓' : '✗'
      console.log(`  ${flag} 细化 ${r.status} ｜ ${(r.durationMs / 1000).toFixed(1)}s ｜ in=${r.input} out=${r.output} ｜ ¥${(r.cost || 0).toFixed(4)}${r.error ? ` ｜ err=${r.error}` : ''}`)
      if (r.warnings?.length) console.log(`     warnings(${r.warnings.length})：${r.warnings[0]}`)
      cost += r.cost || 0; inTok += r.input || 0; outTok += r.output || 0
      note('detail-window', `细化下一组 ${r.status}`, r)
      const { project: after } = await apiOk(`/api/projects/${projectId}`)
      const through = after.outline?.plannedDetailThrough
      const auditN = (after.outline?.summaryAudit || []).length
      console.log(`     细化到第 ${through} 章 ｜ 概要审查累计 ${auditN} 条`)
      note('detail-state', `细化后 plannedDetailThrough=${through}`, { through, auditN, notes: after.outlineNotes || [] })
    }

    /* --- 写这一章 --- */
    process.stdout.write(`→ 第 ${no} 章 … `)
    let rec
    try { rec = await writeChapter(projectId, no) }
    catch (e) { rec = { no, status: 'request_error', error: String(e.message || e), durationMs: 0, cost: 0 } }
    events.chapters.push(rec)
    if (rec.status === 'committed') {
      ok++; cost += rec.cost || 0; inTok += rec.input || 0; outTok += rec.output || 0
    } else bad++
    const flag = rec.status === 'committed' ? '✓' : '✗'
    console.log(`${flag} ${rec.status} ${(rec.durationMs / 1000).toFixed(1)}s in=${rec.input ?? '-'} out=${rec.output ?? '-'} ¥${(rec.cost ?? 0).toFixed(4)} risk=${rec.risk} chars=${rec.bodyChars ?? '-'}` +
      (rec.autoAccepted ? ' [风险章已自动接受]' : '') + (rec.error ? ` err=${rec.error}` : ''))
    note('chapter', `第 ${no} 章 ${rec.status}`, rec)

    if (rec.status === 'needs_input' || rec.status === 'stale') {
      console.warn(`  ⚠ 第 ${no} 章需人工介入（${rec.status}）——按设计停止，避免重复扣费。`)
      note('stop', `第 ${no} 章停在 ${rec.status}，已停止`, { no, status: rec.status, error: rec.error })
      break
    }
  }

  /* ---- ⑥ 胡来用例（放最后：此时数据最完整）---- */
  let chaosResults = []
  if (CHAOS) {
    console.log('\n⑥ 胡来用例（全部走不改数据的路径，拒绝发生在模型调用之前 ⇒ 零成本）…')
    const { project, } = await apiOk(`/api/projects/${projectId}`)
    const curNo = (project.chapters || []).length
    chaosResults = await runChaos(projectId, curNo)
    events.chaos = chaosResults
    for (const r of chaosResults) {
      const flag = r.error ? '✗' : (r.expected === r.got ? '✓' : '⚠')
      console.log(`  ${flag} ${r.name}：期望 ${r.expected ?? '—'}，实际 ${r.got ?? r.error ?? '—'}${r.hint ? `（${String(r.hint).slice(0, 60)}）` : ''}`)
    }
  }

  /* ---- 最终状态 ---- */
  const { project: final } = await apiOk(`/api/projects/${projectId}`)
  const committed = (final.chapters || []).filter((c) => c.status === 'committed')
  const totalChars = committed.reduce((s, c) => s + String(c.text || '').replace(/\s/g, '').length, 0)
  const pendingDetail = (final.outline?.volumes || []).flatMap((v) => v.chapters || []).filter((c) => c.pendingDetail).length
  const audit = final.outline?.summaryAudit || []
  const shadow = committed.flatMap((c) => (c.contextNotes || []).map((n) => ({ no: c.no, note: n })))

  const summary = {
    projectId, title: final.title,
    created: events.create,
    chapters: { ok, bad, from: FROM, to: TO, committed: committed.length },
    body: { totalChars, avgChars: committed.length ? Math.round(totalChars / committed.length) : 0 },
    cost: { total: Number(cost.toFixed(4)), input: inTok, output: outTok, perChapter: committed.length ? Number((cost / committed.length).toFixed(4)) : 0 },
    wallMs: Date.now() - t0,
    detailWindows: events.detailWindows,
    changes: events.changes,
    finalState: {
      pendingReplan: !!final.pendingReplan,
      editRevision: final.editRevision,
      plannedDetailThrough: final.outline?.plannedDetailThrough,
      pendingDetailChapters: pendingDetail,
      foreshadows: (final.outline?.foreshadows || []).length,
      entities: (final.entities || []).length,
      outlineNotes: final.outlineNotes || [],
      summaryAudit: audit,
      contextNotes: shadow,
    },
    chaos: chaosResults,
  }
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2))

  console.log('\n==========================================================')
  console.log(' 汇总')
  console.log('==========================================================')
  console.log(`  作品     : 《${final.title}》 ${projectId}`)
  console.log(`  正文     : ${committed.length} 章定稿 ｜ ${totalChars} 字 ｜ 均 ${summary.body.avgChars} 字/章`)
  console.log(`  花费     : ¥${summary.cost.total.toFixed(4)}（均 ¥${summary.cost.perChapter.toFixed(4)}/章）`)
  console.log(`  耗时     : ${((summary.wallMs) / 1000 / 60).toFixed(1)} 分钟`)
  console.log(`  细化窗口 : ${events.detailWindows.length} 次，命中概要审查 ${audit.length} 条`)
  console.log(`  改设定   : ${events.changes.filter((c) => c.approved).length}/${events.changes.length} 批准成功`)
  console.log(`  胡来用例 : ${chaosResults.filter((r) => !r.error).length}/${chaosResults.length} 未抛错`)
  console.log(`  最终状态 : pendingReplan=${summary.finalState.pendingReplan} ｜ 占位章 ${pendingDetail} ｜ 投影诊断 ${shadow.length} 条`)
  console.log(`  汇整文件 : ${SUMMARY}`)
  if (summary.finalState.outlineNotes.length) {
    console.log('\n  概要审查明细：')
    for (const n of summary.finalState.outlineNotes) console.log(`    · ${n}`)
  }
  if (shadow.length) {
    console.log('\n  章节投影诊断：')
    for (const s of shadow.slice(0, 10)) console.log(`    · 第 ${s.no} 章：${s.note}`)
  }
}

main().catch((e) => {
  console.error('\n✗ 失败：', e.message || e)
  try { appendFileSync(OUT, JSON.stringify({ kind: 'fatal', error: String(e.message || e) }) + '\n') } catch {}
  process.exit(1)
})
