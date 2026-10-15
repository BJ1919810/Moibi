/**
 * 作者改篇幅后的“未来章节重排”：只更新未写计划，不覆盖正式正文。
 * 全书主线与秘密仅在高权限重排模型可见，新生成的 writerTask 保持 proposed，
 * 之后仍由低权限 L2/正文投影安全细化，不能借一次重排自动批准秘密揭示。
 */
import crypto from 'node:crypto'
import { chat } from './providers/openai.js'
import * as store from './store.js'
import { calculateCost, usageSummary, assertCostBudget } from './cost.js'
import { auditWriterSummaries, outlineAuditNotes } from './pipeline.js'
// 伏笔动作归一与开书路径**共用同一份实现**（见 schema.js 的说明：曾经只有这边做了归一，
// 开书路径零归一 ⇒ 一条「埋设」让某章永久写不出来）
import { normalizeForeshadowAction, normalizeCastIds } from './schema.js'
// 并发互斥的判据只有一份（server/run-status.js）—— 别再在这里抄一份状态列表
import { findBlockingRun, RESUMABLE_REPLAN_STATUSES } from './run-status.js'

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,24)
const clone = (x) => structuredClone(x)
const MAX_CHUNK = 5
function writtenMax(p) { return Math.max(0, ...(p.chapters || []).filter((c) => c.status === 'committed').map((c) => c.no)) }

/**
 * 伏笔 id 归一化：把模型写出的 id 映射回大纲里真实存在的那个 id。
 *
 * **为什么必须归一，而不是直接判非法**：
 * 模型见到的是 f1/f2… 这种短 id，输出时经常改写成 `F1`、`f-1`、"F 1"、
 * 甚至整条把 id 写成伏笔的 seed 文本。原来的实现遇到任何一点不一致就
 * 抛「滚动规划的伏笔引用非法」，导致**整批 5 章规划全部作废** ——
 * 用户看到的就是「细化下一组」永远失败。
 * id 只是内部外键，写法漂移不该毁掉整批内容；归一不到才判非法。
 */
function normalizeForeshadowId(rawId, fsIdSet) {
  const raw = String(rawId ?? '').trim()
  if (!raw) return null
  if (fsIdSet.has(raw)) return raw
  // 大小写、空白、连字符/下划线的写法漂移：f1 / F1 / f-1 / f_1 / " f 1 " 视为同一个
  const canon = (s) => s.toLowerCase().replace(/[\s\-_]/g, '')
  const wanted = canon(raw)
  for (const id of fsIdSet) if (canon(id) === wanted) return id
  return null
}

/**
 * 动作归一化已提到 `schema.normalizeForeshadowAction`（**唯一一份**，开书路径共用）。
 * 这里不再保留副本 —— 两处实现一定会漂移，而漂移的代价是「某章永久写不出来」。
 */

/**
 * 把模型给的 foreshadows 数组整理成合法的 {id, action, approved} 列表。
 *
 * 三档处理，从宽到严：
 *   1. id 能归一 + 动作能归一 → 接受（回收一律 approved=false，模型无权自我批准）
 *   2. id 能归一但动作非法 → 丢弃该条（记一条 warning）
 *   3. id 归一不到 → 丢弃该条（记一条 warning），**不抛错**
 * 只有「整批被模型塞满无效引用」这种明显坏输出才由调用方决定是否拒绝。
 */
function normalizeForeshadowActions(rawList, fsIdSet, warnings, where) {
  if (!Array.isArray(rawList)) return []
  const out = []
  for (const f of rawList) {
    const id = normalizeForeshadowId(f?.id ?? f?.foreshadowId, fsIdSet)
    if (!id) {
      warnings.push(`${where}引用了大纲中不存在的伏笔 ${JSON.stringify(String(f?.id ?? '').slice(0, 24))}，已忽略该条`)
      continue
    }
    const action = normalizeForeshadowAction(f?.action)
    if (!action) {
      warnings.push(`${where}伏笔 ${id} 的动作 ${JSON.stringify(String(f?.action ?? '').slice(0, 16))} 无法识别，已忽略该条`)
      continue
    }
    out.push({ id, action, approved: action !== 'pay_off' })
  }
  // 同一章重复引用同一伏笔：按 plant < reinforce < pay_off 取最强的一个，避免留下矛盾指令
  const rank = { plant: 0, reinforce: 1, pay_off: 2 }
  const merged = new Map()
  for (const a of out) {
    const prev = merged.get(a.id)
    if (!prev || rank[a.action] > rank[prev.action]) merged.set(a.id, a)
  }
  return [...merged.values()]
}

/**
 * 实体 id 归一：与伏笔同理，模型可能给名字而不是 id，也可能把 id 大小写写歪。
 * 名字/别名能对上的直接换成 id；仍对不上则丢弃（不整批作废）。
 *
 * 名称比对也走 canon：`林奇` / `林 奇` / `LIN QI`（英文名大小写）都视为同一个。
 * 只 trim 而不做 canon 时，「名字中间被模型插了个空格」这种漂移会白白丢掉整条选角。
 *
 * ⛔ 实现已搬到 `schema.normalizeCastIds`（**唯一实现**）：开书路径原来自己写了一句
 *    `map(n => nameToId.get(String(n).trim())).filter(Boolean)` —— 零 canon、零别名、还静默丢人。
 *    同一份数据在两条路径上的角色可见性因此不同。现在两条路径共用这一份。
 */

/**
 * 作者改篇幅后的“未来章节重排”：只更新未写计划，不覆盖正式正文。
 * 全书主线与秘密仅在高权限重排模型可见，新生成的 writerTask 保持 proposed，
 * 之后仍由低权限 L2/正文投影安全细化，不能借一次重排自动批准秘密揭示。
 *
 * @returns {{project:object, warnings:string[]}} 归一化后的新项目 + 被忽略项的诊断
 */
/** 同一章重复引用同一伏笔时取最强动作的排序 */
const ACTION_RANK = { plant: 0, reinforce: 1, pay_off: 2 }

/**
 * 回收章自检（window 与 full 两条路径共用）。
 *
 * ⛔ 真实踩坑（v2.0.0 第二轮全量压测《风起处见线》第 7 章）：模型把 `f3/pay_off` 排到第 7 章，
 *    而 f3 自己声明的回收章是**第 16 章**（差 9 章）。同一批排期里 6 条 `pay_off` 有 **5 条错位**
 *    （第 23/26/28/29/30 章）—— 不是偶发，是**没有任何东西在管回收侧**：
 *    · `replanMessages` 里虽然列了「收:16」，但那只是**信息**不是**约束**；
 *    · `applyFuturePlan`（full 模式）连铺设侧自检都没有；`applyRollingWindowPlan` 只有铺设侧。
 *    而 `revealDecision()` 有 `chapterNum(payoffChapter) !== meta.no ⇒ wrong-chapter` 这条判据
 *    ⇒ 排错的那一章在**模型调用之前**就被 `projectForeshadows()` deny ⇒ **永远写不出来**。
 *
 * 处理原则（与 `state-engine` 的分级判据一致：**这条坏数据会不会污染别处**）：
 *    排错章的 `pay_off` **就地降级为 `reinforce`**，不改动伏笔自己的声明 ——
 *    「在正确的章回收」是作者的设计意图，不该因模型排错而让整章卡死。
 *    ⚠️ 降级**绝不等于授权**：`reinforce` 的 `approved` 虽为 true，但它**不产生回收权**；
 *    `revealDecision()` 要求的是 `action === 'pay_off' && approved`，降级后天然不满足。
 *
 * @returns {string[]} warnings（调用方并入各自的 warnings 数组）
 *
 * ⚠️ **同时导出**：历史数据里已经存在的错位（在本次修复之前排的）不会自己消失，
 *    需要一个可复用的修复入口。见 `scripts/fix-misplaced-payoffs.mjs`。
 */
export function downgradeMisplacedPayoffs(chapters, outline, warnings = []) {
  const revealAtOf = new Map(
    (outline?.foreshadows || []).map((f) => [f.id, Number(f.payoffChapter ?? f.revealAt) || null])
  )
  for (const c of chapters) {
    for (const a of c.foreshadows || []) {
      if (a.action !== 'pay_off') continue
      const want = revealAtOf.get(a.id)
      // 声明了回收章、且不是本章 ⇒ 错位。没声明回收章的（want 为空）保持原样，交给门禁判 no-explicit-action。
      if (want && want !== c.no) {
        warnings.push(`伏笔 ${a.id} 的回收章应是第 ${want} 章，但第 ${c.no} 章被排了 pay_off，已自动降级为 reinforce（不会因此获得回收授权）`)
        a.action = 'reinforce'
        a.approved = true
      }
    }
  }
  return warnings
}

export function applyFuturePlan(project, proposals, { expectedHeadVersion, expectedEditRevision } = {}) {
  if (Number(project.headVersion || 0) !== Number(expectedHeadVersion) || Number(project.editRevision || 0) !== Number(expectedEditRevision)) throw new Error('重排基线版本过期')
  const committed = writtenMax(project)
  const total = Number(project.targetChapters)
  if (!Number.isInteger(total) || total < committed || proposals.length !== total - committed) throw new Error('重排章节数量不符合目标')
  const fsIdSet = new Set((project.outline?.foreshadows || []).map((f) => f.id))
  const warnings = []
  const oldAll = (project.outline?.volumes || []).flatMap((v) => (v.chapters || []).map((c) => ({ ...c, volumeTitle: v.title })))
  const past = oldAll.filter((c) => c.no <= committed)
  const next = clone(project)
  const future = proposals.map((a, i) => {
    const { ids: cast } = normalizeCastIds(a.cast, project, warnings)
    if (a.foreshadows != null && !Array.isArray(a.foreshadows)) throw new Error('未来伏笔引用不是数组')
    const foreshadows = normalizeForeshadowActions(a.foreshadows, fsIdSet, warnings, `第 ${committed + i + 1} 章`)
    return { no: committed + i + 1, title: String(a.title || `第${committed+i+1}章`).slice(0,80),
      summary: String(a.summary || '').slice(0,500), goal: String(a.goal || '').slice(0,300),
      writerSummary: String(a.writerSummary || '').slice(0,200), writerGoal: String(a.writerGoal || '').slice(0,120),
      writerTaskApproval: 'proposed', authorInstruction:oldAll.find(x=>x.no===committed+i+1)?.authorInstruction || '', cast, castSource: 'model-replan', foreshadows, reveals: [], requiredFactIds: [] }
  })
  const vols = []
  if (past.length) vols.push({ title: '已确认章节', goal: '已发生剧情，不参与重排', chapters: past.map(({ volumeTitle, ...c }) => c) })
  for (let i = 0; i < future.length; i += MAX_CHUNK) {
    vols.push({ title: `后续规划 ${Math.floor(i / MAX_CHUNK) + 1}`, goal: '滚动规划，未发生', chapters: future.slice(i,i+MAX_CHUNK) })
  }
  next.outline.volumes = vols
  next.outline.totalChapters = total
  next.outline.plannedDetailThrough = total
  next.outline.planningMode = 'complete'
  next.pendingReplan = false
  // ②b 回收侧自检（full 模式原先**连铺设侧都没有**）。
  //    本批排期里 6 条 pay_off 有 5 条与「伏笔自己声明的回收章」错位（第 7/23/26/28/29/30 章），
  //    错位章会被 revealDecision 判 wrong-chapter 而**整章写不出来**。详见 downgradeMisplacedPayoffs。
  downgradeMisplacedPayoffs(future, next.outline, warnings)
  next.editRevision = Number(next.editRevision || 0) + 1
  next.replanHistory ||= []
  next.replanHistory.push({ at: new Date().toISOString(), headVersion: expectedHeadVersion, from: committed+1, to: total })
  return { project: next, warnings }
}

/**
 * 小窗口补细化：只填 3～5 章的占位，不重写任何其他未来章节、更不动正文。
 * 未批准的 writer 字段始终保持 proposed，只有下一次 L2 / WriterPacket 才能进入正文。
 *
 * 外键（伏笔 id / 角色 id）走**宽容归一**：模型写法漂移只丢弃该条并记 warning，
 * 不再因为一个 `F1` vs `f1` 把整批 5 章细化全部作废（这正是「细化下一组」长期失败的主因）。
 *
 * ⚠️ 披露（reveals）在滚动细化阶段**一律不落**：细化的是尚未动笔的章节，
 * 而披露必须由一次真实定稿的正文证据来授权（见 workflow.js 的 releaseGate）。
 * 模型在这里提出的任何 reveals 都会被丢弃，避免「计划揭示」被误当成「已经揭示」。
 *
 * 章节号也不信模型：一律按 fromNo + i 强制重编号，模型写歪章号不会污染结构。
 *
 * @returns {{project:object, warnings:string[]}}
 */
export function applyRollingWindowPlan(project, proposals, { expectedHeadVersion, expectedEditRevision, fromNo } = {}) {
  if (Number(project.headVersion || 0) !== Number(expectedHeadVersion) || Number(project.editRevision || 0) !== Number(expectedEditRevision)) throw new Error('滚动规划版本已过期')
  if (project.pendingReplan) throw new Error('全局设定待重排，不能局部细化')
  if (!Array.isArray(proposals) || !proposals.length || proposals.length > MAX_CHUNK) throw new Error('滚动窗口必须为 1～5 章')
  const next = clone(project)
  const fsIdSet = new Set((next.outline?.foreshadows || []).map(f => f.id))
  const foreshadowTotal = fsIdSet.size
  const warnings = []
  const chapters = (next.outline?.volumes || []).flatMap(v => v.chapters || [])
  const committedNos = new Set((next.chapters || []).filter(c => c.status === 'committed').map(c => c.no))
  const detailFrom = Number(project.outline?.plannedDetailThrough || 0) + 1
  let droppedForeshadowRefs = 0
  for (let i = 0; i < proposals.length; i++) {
    const no = fromNo + i, candidate = proposals[i]
    const target = chapters.find(c => c.no === no)
    if (!target || !target.pendingDetail || committedNos.has(no)) throw new Error('滚动窗口不能覆盖已细化或已定稿章节')
    if (!candidate || typeof candidate !== 'object') throw new Error('滚动规划章节格式无效')
    // ① 细化窗口必须紧接已细化区，且不能越过任何一章尚未定稿的章节。
    //    否则「第 10 章已被细化、第 9 章还是占位」这种空洞会让正文生成时取不到前置计划。
    if (no !== detailFrom + i) throw new Error(`滚动窗口必须从第 ${detailFrom + i} 章起连续细化（请求的第 ${no} 章不在此位置）`)
    const { ids: cast } = normalizeCastIds(candidate.cast, project, warnings)
    if (candidate.foreshadows != null && !Array.isArray(candidate.foreshadows)) throw new Error('滚动规划伏笔格式无效')
    const before = warnings.length
    const foreshadows = normalizeForeshadowActions(candidate.foreshadows, fsIdSet, warnings, `第 ${no} 章`)
    droppedForeshadowRefs += warnings.length - before
    Object.assign(target, { title:String(candidate.title || `第${no}章`).slice(0,80),
      summary:String(candidate.summary || '').slice(0,500), goal:String(candidate.goal || '').slice(0,300),
      writerSummary:String(candidate.writerSummary || '').slice(0,200),writerGoal:String(candidate.writerGoal || '').slice(0,120),
      writerTaskApproval:'proposed',cast,castSource:'model-window',foreshadows,reveals:[],requiredFactIds:[] })
    delete target.pendingDetail
  }
  // ② 伏笔位置自检：滚动细化到某章时，大纲声明的「计划铺设章」已经过去却一次都没排上，
  //    说明这条伏笔已经脱轨。这不该让整批细化失败（用户要的是能继续写），
  //    但必须**明确写进警告**，否则它会一路静默到回收章才炸。
  const scheduled = new Set()
  for (const c of chapters) for (const a of c.foreshadows || []) scheduled.add(`${a.id}|${a.action}`)
  for (const f of next.outline?.foreshadows || []) {
    const plantAt = Number(f.plantChapter ?? f.plantAt) || null
    if (plantAt && plantAt <= fromNo + proposals.length - 1 && !scheduled.has(`${f.id}|plant`) && !scheduled.has(`${f.id}|reinforce`)) {
      warnings.push(`伏笔 ${f.id} 的计划铺设章是第 ${plantAt} 章，但该章窗口没有安排铺设动作，可能需要人工调整`)
    }
  }
  // ②b 回收侧自检（window 与 full 共用同一实现，避免两处漂移）——
  //    原先**完全缺失**，是「带伏笔的书必卡在回收章」的直接成因。详见 downgradeMisplacedPayoffs。
  downgradeMisplacedPayoffs(chapters, next.outline, warnings)
  const remaining = chapters.filter(c => c.pendingDetail).map(c => c.no)
  next.outline.plannedDetailThrough = remaining.length ? Math.min(...remaining)-1 : Number(next.targetChapters)
  next.outline.planningMode = remaining.length ? 'rolling' : 'complete'
  next.editRevision = Number(next.editRevision || 0)+1
  next.replanHistory ||= []
  next.replanHistory.push({ at:new Date().toISOString(), type:'rolling-window', from:fromNo,
    to:fromNo+proposals.length-1, headVersion:expectedHeadVersion,
    ...(warnings.length ? { warnings: warnings.slice(0, 12) } : {}) })
  return { project: next, warnings, foreshadowTotal }
}

export function replanMessages(p, fromNo, count, already) {
  const characters = (p.entities || []).map((e) => ({ id: e.id, name: e.name, publicIdentity: e.publicIdentity, authorRole: e.authorRole, secret: e.secret, want: e.want, characterCard:e.characterCard || {} }))
  const foreshadows = (p.outline?.foreshadows || []).map((f) => ({ id: f.id, seed: f.seed, payoff: f.payoff, linkStatus: f.linkStatus,
    plantChapter: f.plantChapter ?? f.plantAt ?? null, payoffChapter: f.payoffChapter ?? f.revealAt ?? null }))
  const author = { idea: p.idea, genre: p.genre, targetChapters: p.targetChapters,
    preferences: p.preferences || {}, authorWorldRules:p.authorWorldRules || '', authorPlotDirection:p.authorPlotDirection || '', theme: p.outline?.theme, acts: p.outline?.acts,
    characters,
    foreshadows,
    confirmed: (p.chapters || []).filter((ch) => ch.status === 'committed').map(({no,summary}) => ({no,summary})),
    volumeMilestones:p.outline?.volumeMilestones || [], chapterIntents:(p.outline?.volumes||[]).flatMap(v=>v.chapters||[]).filter(c=>c.authorInstruction).map(c=>({no:c.no,instruction:c.authorInstruction})), precedingPlans: already.slice(-4).map(({title,summary}) => ({title,summary})) }
  // 硬约束必须把「可用的 id 全集」和「允许的取值」摆出来：
  //   · cast 只能是 characters[].id，不能写名字、不能自创
  //   · foreshadows[].id 只能从下面列出的 id 里挑；没有合适的就**留空数组**，不要硬塞
  // 模型看不到这两个清单时最容易自创 id，之前的「滚动规划的伏笔引用非法」正是这么来的。
  const castIds = characters.map((c) => c.id).join('、') || '（无）'
  const fsIds = foreshadows.map((f) => `${f.id}（埋:${f.plantChapter ?? '?'} 收:${f.payoffChapter ?? '?'}）`).join('、') || '（本作暂无伏笔）'
  // ⛔ 真实踩坑（v2.0.0 第二轮全量压测，《风起处见线》第 7 章）：提示词里**已经**写了
  //    `f3（埋:1 收:16）`，模型却把 `f3/pay_off` 排到了**第 7 章** —— 与声明的回收章差 9 章。
  //    因为「收:16」只是**信息**，不是**约束**：题面没有任何一句话禁止模型提前回收。
  //    后果链：`revealDecision()` 判 `wrong-chapter` ⇒ `projectForeshadows()` 永远 deny
  //    ⇒ 第 7 章在**模型调用之前**就被拦死（¥0，但也永远写不出来）。
  //    同批还有 5 条错位（第 23/26/28/29/30 章），说明这不是偶发。
  //    修法：把「回收章」提升为**硬约束**，并明确「不是回收章就不要输出 pay_off」。
  const revealLines = foreshadows
    .filter((f) => f.payoffChapter)
    .map((f) => `  · ${f.id} → 第 ${f.payoffChapter} 章（只允许出现在这一章）`)
    .join('\n') || '  （本作暂无设定了回收章的伏笔）'
  /**
   * 全书位置 → 阶段要求。
   *
   * ⛔ 缺口（2026-10-14 发现）：L1 全书规划**明确**写了总章数，还把「三幕要概括全书走向、
   *    不要只写开头」写成要求；但这一层（滚动 L2）只把 `targetChapters` 塞进 JSON 当**机器字段**，
   *    **从没把位置翻译成节奏要求**。后果：规划模型不知道自己还剩多少空间，
   *    本能地**把手头的料尽早用掉** —— 该埋的提前揭，真相措辞就渗进了 writerSummary
   *    （概要审查报警的机制之一）。
   *    与「末章不该要求留接口」是同一类病：**信息给了，规矩没随位置变**。
   *    注意它与下面的「回收章硬约束」是**互补**关系：硬约束管「能不能收」（客观门禁），
   *    这里管「该不该收、该埋还是该收」（软提示）。
   */
  const total = Number(p.targetChapters) || null
  const toNo = fromNo + count - 1
  const stage = (() => {
    if (!total) return null
    const p1 = Math.round(((fromNo - 1) / total) * 100)
    const p2 = Math.round((toNo / total) * 100)
    const where = `全书目标 ${total} 章，本次规划第 ${fromNo}–${toNo} 章（约占全书的 ${p1}%–${p2}%）`
    if (toNo <= total * 0.25) {
      return { where, name: '开篇',
        rule: '只埋不收：可以铺设与强化线索，**不要回收任何伏笔**，也不要解释任何线索的真实含义 —— 这一段的读者还不知道自己要面对什么。' }
    }
    // 「包含末章的那一段」按定义就是收尾段 —— 否则 10 章的书里 ch6–10（占 50%–100%）
    // 会被判成「中段」，而它其实一路写到结局。
    if (fromNo > total * 0.8 || toNo >= total) {
      return { where, name: '末段',
        rule: '开始收线：优先安排「已铺设但尚未回收」的伏笔按各自的回收章收口，为结局腾出空间；不要再新埋需要很长篇幅才能收的长线。' }
    }
    return { where, name: '中段',
      rule: '推进与试探：可以按计划回收**已经到期**的线（到期与否由下面的硬约束判定），可以加深读者对已有线索的理解，但不要提前揭晓任何真相。' }
  })()
  return [{ role: 'system', content: '你是高权限全局规划器，负责重新安排尚未发生的章节；已确认正文不可更改。严禁把作者秘密放进 writerSummary/writerGoal。只输出 JSON。' },
    { role: 'user', content: `以下是作者可见数据：\n${JSON.stringify(author)}\n\n请为第${fromNo}到${fromNo+count-1}章规划恰好${count}章。连续承接已确认剧情和前面的新规划。
${stage ? `
【全书位置与阶段】
${stage.where} —— 属于**${stage.name}**。
${stage.rule}
⛔ 不要为了「想制造高潮」而提前揭示任何秘密：提前揭晓比暂时不揭更糟，而且**事后收不回来**（正文已付费）。
` : ''}
【可用的角色 ID（cast 只能填这些，禁止填名字、禁止自创）】
${castIds}

【本作现有的伏笔 ID（foreshadows[].id 只能从这里选；写法必须逐字一致）】
${fsIds}

【⛔ 伏笔回收章是硬约束 —— 每条伏笔只允许在它自己声明的那一章回收】
${revealLines}
- 上面写了「第 N 章」的伏笔，**只有第 N 章**这一章允许给它写 pay_off；
  其它章节对它**只能**用 plant / reinforce，或者干脆不提。
- 把 pay_off 排到别的章会被系统判为「回收章错位」而**直接拒绝生成**（不是警告，是整章写不出来）。
- 如果你判断这条线确实该提前收，**不要擅自改**：照约束排，把想法写进章节的 summary 说明，
  由作者决定是否调整伏笔声明。

每章输出：title, summary(作者视角), goal, writerSummary(安全表层), writerGoal(安全表层), cast(角色 ID 数组), foreshadows([{id,action}])。
硬性要求：
- foreshadows[].action 只能是 "plant"（铺设）/"reinforce"（强化）/"pay_off"（回收）三者之一，禁止中文或其它写法。
- 某一章不需要推进任何伏笔时，foreshadows 直接给空数组 []，不要为了凑内容编造 id。
- 不得引用上面清单之外的任何角色 ID 或伏笔 ID。
- pay_off **必须**与上面「回收章」清单逐条对齐；对不齐就改用 reinforce。
- 回收（pay_off）不得自行审批（approved 由系统决定，你不用也不该输出这个字段）。
返回 {"chapters":[...]}。` }]
}

/** 与章写作一样持久化每一批结果；重启中途不自动重新扣费。 */
export function createReplanService({ repo = store, model = chat, config = store.getConfig } = {}) {
  const active = new Set()
  const getRun = (id) => repo.getRun(id)
  function save(r) { r.updatedAt = new Date().toISOString(); repo.saveRun(r); return r }
  function create(projectId, { mode = 'full' } = {}) {
    const p = repo.getProject(projectId)
    if (!p) throw new Error('作品不存在')
    if (!['full','window'].includes(mode)) throw new Error('未知规划方式')
    if (mode === 'full' && !p.pendingReplan) throw new Error('没有待重排的篇幅或剧情')
    if (mode === 'window' && p.pendingReplan) throw new Error('请先完成全局重排')
    const pending = (p.outline?.volumes || []).flatMap(v => v.chapters || [])
      .filter(c => c.pendingDetail && !(p.chapters || []).some(ch => ch.no === c.no && ch.status === 'committed'))
      .sort((a,b)=>a.no-b.no)
    if (mode === 'window' && !pending.length) throw new Error('当前没有需要细化的章节窗口')
    const windowStart = mode === 'window' ? pending[0].no : null
    const windowCount = mode === 'window' ? Math.min(MAX_CHUNK, pending.filter((c,i) => c.no === windowStart+i).length) : null
    const id = `run_${hash(`replan|${mode}|${projectId}|${p.editRevision || 0}`)}`
    const old = getRun(id)
    // 任务 id 是「模式 + 作品 + 修订号」的确定性哈希，所以同一次修订下重复点「细化下一组」
    // 会命中同一个 run。**这也意味着旧失败会被一直返回**：
    // 路由只在 `status === 'queued'` 时才触发 process()，若这里原样返回 needs_input，
    // 用户点「细化下一组」就只看到上次的报错、什么都不会发生（必须先点「恢复规划」）。
    // ⇒ 把可恢复的失败**就地重置为 queued**，让「再点一次」的语义变成「重试」。
    if (old) {
      // 只重置**终态的失败**：进行中的任务原样返回，避免把正在跑的状态打回 queued。
      if (['needs_input', 'failed'].includes(old.status)) {
        old.status = 'queued'; old.step = 'queued'; old.error = null
        return save(old)
      }
      return old
    }
    // 与 workflow.createRun() 用**同一份白名单**：只拦「真的在跑 / 真的在等确认」的状态。
    // ⛔ 原先这里是黑名单（只排除 committed/cancelled/failed/stale），漏了 `needs_input`
    //    ⇒ 一个**已经停住**的细化任务会把该作品的所有重排永久锁死；而此时若
    //    `pendingReplan=true`，正文生成也一并被拦 ⇒ **两头堵死，界面上没有任何出路**
    //    （「重新生成本章正文」那个出口并不存在）。
    //    真实现场：2026-10-13 第四轮《搬物记事》压测 —— 第 3 章后细化失败留下 needs_input，
    //    随后全局重排报「已有正在执行的任务」，第 4～8 章全部被 pendingReplan 拦下。
    //    `awaiting_acceptance` 故意保留在名单里：那是在等作者确认本章，不该被重排改写基线。
    if (findBlockingRun((repo.listRuns?.(projectId) || []).filter((r) => r.projectId === projectId))) throw new Error('已有正在执行的任务')
    return save({ id, type: 'replan', mode, windowStart, windowCount, projectId,
      baseHeadVersion: p.headVersion || 0, baseEditRevision: p.editRevision || 0,
      targetChapters: p.targetChapters, status: 'queued', step: 'queued', proposals: [], usage: [], createdAt: new Date().toISOString() })
  }
  async function process(id) {
    if (active.has(id)) return getRun(id)
    let r = getRun(id)
    if (!r || r.type !== 'replan') throw new Error('重排任务不存在')
    if (['committed','cancelled','stale'].includes(r.status)) return r
    if (r.status === 'writing') return save({ ...r, status: 'needs_input', error: '上次重排模型请求结果不确定，请手动恢复' })
    active.add(id)
    try {
      const p = repo.getProject(r.projectId)
      if (Number(p?.headVersion || 0) !== Number(r.baseHeadVersion) || Number(p?.editRevision || 0) !== Number(r.baseEditRevision)) return save({ ...r, status: 'stale', error: '计划版本已过期' })
      const total = r.mode === 'window' ? r.windowCount : p.targetChapters - writtenMax(p)
      const from = r.mode === 'window' ? r.windowStart : writtenMax(p) + 1
      const collectWarnings = []
      while (r.proposals.length < total) {
        const count = Math.min(MAX_CHUNK, total - r.proposals.length)
        const messages = replanMessages(p, from + r.proposals.length, count, r.proposals)
        const cfg = config(), rates = cfg.pricing || null
        const used = calculateCost(r.usage, rates)
        const possible = calculateCost([{inputTokens: JSON.stringify(messages).length, outputTokens: 2600}], rates)
        if (used != null && possible != null) assertCostBudget(used, possible, cfg.replanBudget)
        r.status = 'writing'; r.step = `plan-chunk-${r.proposals.length+1}`; save(r)
        const response = await model({ ...cfg, messages, jsonMode: true, thinking: false, maxTokens: 2600, retries: 0 })
        if (getRun(id).status === 'cancelled') return getRun(id)
        r.usage.push({ ...(response.usage || {}), step: 'replan' })
        // ⚠️ 必须**立刻落盘**这次用量：下面的失败路径会 `getRun(id)` 重新读盘
        //    （store.getRun 是 readJSON，不读内存），内存里这次**已经付费**的用量会被丢掉。
        //    后果有两个：界面看不到这笔钱；而 `assertCostBudget` 正是按 `r.usage` 累计的，
        //    漏记会让 replanBudget 熔断被反复失败绕过（真实现场见 2026-10-13 第四轮压测）。
        save(r)
        if (response.finishReason === 'length') throw new Error('本批重排输出截断')
        const parsed = JSON.parse(String(response.text || '').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim())
        /**
         * ⛔ 这里曾经要求 `parsed.chapters.length === count`（**精确相等**）——
         * 与开书路径「必须恰好 N 章」是同一个病：模型对数量从来没这么听话（实测 25/22/21 vs 24）。
         * 代价不是「少排几章」，而是整个细化/重排任务直接 `needs_input`；再叠加
         * 「已有正在执行的任务」缺 `needs_input`（见下方 create），作品会**彻底写不动**。
         * （真实现场：2026-10-13 第四轮《搬物记事》压测，第 3 章后细化失败 ⇒ 后 5 章全被拦。）
         *
         * 现在的判据：**至少 1 章就接受**。
         *   · 少给：按实际数量推进，`while` 会接着请求剩下的（不丢已付费输出）；
         *   · 多给：只取本次需要的 `count` 章 —— 上限必须是 MAX_CHUNK，
         *     因为 `applyRollingWindowPlan()` 明确只接受 1～5 章；多出的部分如实写进 warnings。
         */
        if (!Array.isArray(parsed.chapters) || !parsed.chapters.length) throw new Error('重排模型没有返回任何章节')
        if (parsed.chapters.length > count) {
          collectWarnings.push(`模型一次返回 ${parsed.chapters.length} 章，超出本次请求的 ${count} 章；已采用前 ${count} 章，其余未采用`)
        }
        r.proposals.push(...parsed.chapters.slice(0, count))
        r.status = 'planning'; r.step = 'chunk-saved'; save(r)
      }
      const options = { expectedHeadVersion: r.baseHeadVersion, expectedEditRevision: r.baseEditRevision }
      const applied = r.mode === 'window' ? applyRollingWindowPlan(p, r.proposals, { ...options, fromNo: r.windowStart })
        : applyFuturePlan(p, r.proposals, options)
      // 归一化过程中被丢弃的引用（模型写法漂移）必须留在 run 上：
      // 静默丢弃会让作者以为「大纲里已经有这条伏笔的安排了」，实际没有。
      r.warnings = [...collectWarnings, ...(applied.warnings || [])]
      const next = applied.project

      // 章节概要审查：重排模型也在写 writerSummary，同样可能把 payoff 的真相抄进表层。
      // 与大纲生成路径共用同一个判据（`auditWriterSummaries`），结果并入同一个 warnings 通道
      // —— run 上已经有这个字段、界面也已经在显示它，不必再开一条诊断链。
      const audit = auditWriterSummaries(next.outline?.volumes || [], next.outline?.foreshadows || [], next)
      for (const note of outlineAuditNotes(audit, next)) r.warnings.push(note)
      next.outline ||= {}
      next.outline.summaryAudit = audit

      if (r.warnings.length) console.warn(`[replan ${id}] ${r.warnings.join('；')}`)
      if (repo.commitProjectEdit) repo.commitProjectEdit(next, r.baseHeadVersion, r.baseEditRevision)
      else repo.saveProject(next)
      r.status = 'committed'; r.step = 'committed'; r.cost = usageSummary(r.usage, config().pricing || null)
      // 成功路径必须清掉上一次失败的 error：否则界面会一边显示「已完成」一边挂着旧的报错，
      // 用户会以为修复没生效（同为 workflow.accept 的既有小瑕疵）。
      r.error = null
      return save(r)
    } catch (e) {
      r = getRun(id)
      // 取消是终态，API 返回错误也不能让已取消任务重新变成可恢复状态。
      if (r.status === 'cancelled') return r
      r.status = 'needs_input'; r.error = String(e.message || e)
      return save(r)
    } finally { active.delete(id) }
  }
  async function resume(id) {
    const r = getRun(id)
    if (!r || !RESUMABLE_REPLAN_STATUSES.includes(r.status)) throw new Error('重排任务不可恢复')
    r.status = 'queued'; r.error = null; save(r)
    return process(id)
  }
  function cancel(id) { const r = getRun(id); if (!r || r.status === 'committed') throw new Error('已提交的重排不能取消'); r.status = 'cancelled'; return save(r) }
  return { create, process, resume, cancel, getRun }
}
