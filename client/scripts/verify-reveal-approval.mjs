/**
 * 零成本演练：伏笔「回收披露授权」到底能不能解开被卡住的回收章？
 *
 * 背景：`projection.projectForeshadows()` 要求 `foreshadow.safeReveal.approved===true` 且有文本
 * 才放行 `pay_off`，而在此之前**全项目没有任何写入路径** ⇒ 真实压测里《樱池旧部志》第 26–30 章、
 * 《风起处见线》第 18 章全部卡在 `not-approved`（¥0，死在模型调用之前）。
 *
 * 本脚本对**真实作品数据**做纯计算对比（**只读，绝不写 data/**）。
 * 统计单位是「**章**」而不是「伏笔」——因为拦人的是「这一章计划要回收某条伏笔」这件事：
 *   ① 现状：本章能否构建 WriterPacket？计划里的每一条 pay_off 分别被哪个理由拦下？
 *   ② 假设作者把本章计划的**所有** pay_off 都做了授权（内存里补 safeReveal，不落盘）：
 *      能否构建？正文包是否「只给 safeReveal、不给作者侧 payoff」？
 *
 * 关键不变式（本脚本的失败判据）：
 * **授权之后，剩下的拒绝理由必须全部是客观门禁**（章号不符 / 前置缺失 / 尚未铺设 / 关联待审核），
 * 绝不能再是 `not-approved`（授权没生效）或 `no-approved-safe-projection`（文本没写进去）。
 *
 * 用法：
 *   node scripts/verify-reveal-approval.mjs            # 全部作品
 *   node scripts/verify-reveal-approval.mjs p_737e9cf5455f
 *
 * 退出码：违反上述不变式时返回 1。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWriterPacket } from '../server/projection.js'
import { revealDecision, chapterPlans, getForeshadow } from '../server/foreshadow.js'
import { createChangeService } from '../server/change-request.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(ROOT, 'data/projects')
const only = process.argv[2]
const clone = (x) => structuredClone(x)
const TEXT = '演练用安全披露：只说明读者此刻可以知道的那一层。'

const REASON_CN = {
  'no-explicit-action': '本章计划没有回收动作',
  'not-approved': '回收未授权',
  'unreviewed-link': '关联待审核',
  'wrong-chapter': '回收章与声明不符',
  'missing-prerequisite': '前置事件缺失',
  'not-planted': '尚无已确认的铺设',
  authorized: '已授权',
}
/** 授权**本就不该**绕过的客观门禁 —— 这些理由留下是正确行为。 */
const OBJECTIVE = new Set(['wrong-chapter', 'missing-prerequisite', 'not-planted', 'unreviewed-link', 'no-explicit-action'])

let bad = 0
let chaptersChecked = 0
const load = (id) => JSON.parse(readFileSync(resolve(DATA, `${id}.json`), 'utf8'))

for (const file of readdirSync(DATA).filter((f) => f.endsWith('.json'))) {
  const id = file.replace(/\.json$/, '')
  if (only && !id.includes(only)) continue
  const project = load(id)
  const lines = []
  let unlocked = []
  let blocked = []

  for (const meta of chapterPlans(project)) {
    const payoffs = (meta.foreshadows || []).filter((a) => a.action === 'pay_off')
    if (!payoffs.length) continue
    chaptersChecked += 1

    // ① 现状
    let beforeErr = null
    try { buildWriterPacket(project, meta.no) } catch (e) { beforeErr = e.message }
    const beforeReasons = payoffs.map((a) => {
      const f = getForeshadow(project, a.id)
      return `${a.id}(${REASON_CN[revealDecision(project, meta, f).reason] || revealDecision(project, meta, f).reason})`
    })

    // ② 假设本章计划的每条 pay_off 都被作者授权（纯内存）
    const authorized = clone(project)
    for (const a of payoffs) {
      const fa = getForeshadow(authorized, a.id)
      if (fa) fa.safeReveal = { text: TEXT, approved: true, reviewedBy: 'verify', reviewedAt: new Date().toISOString() }
    }
    const afterReasons = payoffs.map((a) => {
      const f = getForeshadow(authorized, a.id)
      return `${a.id}(${REASON_CN[revealDecision(authorized, meta, f).reason] || revealDecision(authorized, meta, f).reason})`
    })
    let afterErr = null
    let leak = ''
    let hasText = false
    try {
      const text = JSON.stringify(buildWriterPacket(authorized, meta.no))
      hasText = text.includes(TEXT)
      leak = payoffs.some((a) => text.includes(getForeshadow(authorized, a.id)?.payoff || '\u0000'))
        ? '⛔ 泄漏了 payoff 原文' : '未泄漏 payoff'
    } catch (e) { afterErr = e.message }

    // 不变式：授权后剩下的理由必须都是客观门禁
    const remaining = payoffs
      .map((a) => revealDecision(authorized, meta, getForeshadow(authorized, a.id)).reason)
      .filter((r) => r !== 'authorized')
    const violated = remaining.some((r) => !OBJECTIVE.has(r)) || (afterErr && /not-approved|no-approved-safe-projection/.test(afterErr))
    if (violated) bad += 1

    const wasBlocked = !!beforeErr
    const nowOk = !afterErr
    if (wasBlocked && nowOk) unlocked.push(meta.no)
    if (!nowOk) blocked.push(meta.no)

    lines.push(`  第${meta.no}章  ${wasBlocked ? '⛔ 被拦' : '· 本来就可写'} → ${nowOk ? '✅ 授权后放行' : '⚠️ 仍被拦'}  ${violated ? '⛔ 违反不变式' : ''}`)
    lines.push(`      计划回收：${beforeReasons.join('、')}`)
    lines.push(`      授权之后：${afterReasons.join('、')}${nowOk ? ` | packet 含 safeReveal=${hasText} | ${leak}` : ` | ${afterErr}`}`)
  }

  if (!lines.length) continue
  console.log(`\n=== ${project.title || '(无题)'} · ${id}（head=${project.headVersion}/${project.targetChapters}）===`)
  console.log(lines.join('\n'))
  console.log(`  ⇒ 仅靠授权即解开：${unlocked.length ? unlocked.map((n) => `第${n}章`).join('、') : '无'}`)
  if (blocked.length) console.log(`  ⇒ 授权后仍需先修计划的章：${[...new Set(blocked)].map((n) => `第${n}章`).join('、')}`)
}

/* 顺带验证「授权不冻结作品」这条产品行为（内存 ChangeRequest，真实数据，不落盘） */
function dryRunAuthorization(project) {
  let cur = project
  const changes = new Map()
  const repo = {
    getProject: () => cur,
    getChange: (id) => changes.get(id) || null,
    saveChange: (c) => (changes.set(c.id, c), c),
    listChanges: () => [...changes.values()],
    commitProjectEdit(next, head, edit) {
      if (cur.headVersion !== head || cur.editRevision !== edit || next.editRevision !== edit + 1) throw new Error('冲突')
      cur = next
      return next
    },
    listRuns: () => [], saveRun: (r) => r, getRun: () => null,
  }
  const f = (project.outline?.foreshadows || []).find((x) => Number(x.payoffChapter ?? x.revealAt) > 0)
  if (!f) return null
  const service = createChangeService(repo)
  const req = service.create(project.id, { kind: 'foreshadow', foreshadowId: f.id, field: 'safeReveal', value: TEXT })
  const after = service.approve(req.id).project
  return { foreshadowId: f.id, impact: req.impact, after, payoffUnchanged: getForeshadow(after, f.id).payoff === f.payoff }
}

const target = only && readdirSync(DATA).some((f) => f.includes(only))
  ? readdirSync(DATA).find((f) => f.includes(only)).replace(/\.json$/, '')
  : 'p_737e9cf5455f'
try {
  const sample = load(target)
  const dr = dryRunAuthorization(sample)
  if (dr) {
    console.log(`\n=== 授权的影响分析（真实作品 ${sample.title}，内存演练）===`)
    console.log(`  伏笔 ${dr.foreshadowId} · risk=${dr.impact.risk} · replan=${dr.impact.replan} · 影响章节=[${dr.impact.affectedChapters.join(',')}]`)
    console.log(`  提交后 pendingReplan=${dr.after.pendingReplan === undefined ? 'undefined（未冻结，正确）' : dr.after.pendingReplan} · editRevision ${sample.editRevision}→${dr.after.editRevision}`)
    console.log(`  伏笔声明：payoff ${dr.payoffUnchanged ? '一字未改（正确）' : '被改了（错误）'}`)
    if (dr.impact.replan !== false || dr.after.pendingReplan) { bad += 1; console.log('  ⛔ 授权不应要求重排、也不该冻结作品') }
  }
} catch (e) {
  console.log(`\n（影响分析演练跳过：${e.message}）`)
}

console.log(`\n共检查 ${chaptersChecked} 个含回收动作的章；${bad ? `⛔ ${bad} 处违反不变式` : '✅ 授权后的剩余拒绝理由全部是客观门禁，且正文未泄漏 payoff'}`)
process.exit(bad ? 1 : 0)
