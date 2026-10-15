/**
 * WriterPacket —— 送往正文模型的**唯一出口**。
 *
 * 设计原则（第 1 轮评审第 1 条）：
 *   所有进入正文提示词的内容都必须经过本模块投影，其他模块不得自行拼接原始数据。
 *   这样「秘密不进正文」由结构保证，而不是靠每个调用点各自小心。
 *
 * 四层防线：
 *   1. 字段白名单：角色只投影 public 部分，secret 永不外流；
 *   2. 出场约束：只投影本章允许出场的人物（按**实体 ID**，与名字解耦）；
 *   3. 账本投影：状态按相关性挑选，secret 可见性的条目一律剔除；
 *   4. 泄漏断言：findLeaks() 提供确定性校验，生成前作为门禁运行。
 */
import { selectContext, isWriterVisible } from './ledger.js'
import { revealDecision, getForeshadow, readerKnownProjections } from './foreshadow.js'

/* ------------------------------- 数据兼容 ------------------------------- */

/**
 * 正文文风基准。
 *
 * 优先级：合并字段 styleSpec → 旧的三字段（style/tone/pace 拼起来）→ 大纲 style → 默认。
 * styleSpec 是 style/tone/pace 的合并替代（见 author-control.js），
 * 旧数据里仍然只有后三者，所以必须保留这条回退链，不能只认新字段。
 */
export function writerStyleBase(project, outline = null) {
  const p = project?.preferences || {}
  const spec = String(p.styleSpec || '').trim()
  if (spec) return spec
  const legacy = [
    p.style && `文风：${p.style}`,
    p.tone && `基调：${p.tone}`,
    p.pace && `节奏：${p.pace}`,
  ].filter(Boolean).join('；')
  if (legacy) return legacy
  return String(outline?.style || project?.outline?.style || '').trim()
    || '第三人称限知视角，以动作和对话推进。'
}

/** 旧版大纲把「对手/反派」写在 role 里，直接透传会暴露作者视角的定位 */
const NEUTRAL_ROLE = {
  主角: '主角',
  女主: '女主角',
  男主: '男主角',
  配角: '配角',
  对手: '相关人物',
  反派: '相关人物',
}

export function allChapters(outline) {
  const out = []
  for (const v of outline?.volumes || []) {
    for (const c of v.chapters || []) out.push({ ...c, volumeTitle: v.title })
  }
  return out
}

/**
 * 按章号取章节元信息。
 * ⛔ **返回的是副本**（`allChapters` 里 `{...c, volumeTitle}`）——**不要改它的返回值**，
 *    赋值会静默丢失。要写章节字段请用 `liveChapter()`（change-request.js）或自己遍历
 *    `outline.volumes[].chapters[]`。2026-10-13 两个新 kind 就是这么被测试抓出来的。
 */
export function findChapterMeta(outline, no) {
  return allChapters(outline).find((c) => c.no === no) || null
}

/** 取到**活的**（可写）章节对象；找不到返回 null。 */
export function liveChapter(project, no) {
  for (const v of project?.outline?.volumes || []) {
    const hit = (v.chapters || []).find((c) => Number(c.no) === Number(no))
    if (hit) return hit
  }
  return null
}

/* ------------------------------- 索引工具 ------------------------------- */

function buildEntityIndex(project) {
  const byId = new Map()
  const byName = new Map()
  for (const e of project.entities || []) {
    byId.set(e.id, e)
    for (const n of [e.name, ...(e.aliases || [])]) {
      if (n) byName.set(String(n).trim(), e)
    }
  }
  return { byId, byName }
}

/**
 * 出场名单的**三种含义**（第 2 轮评审问题 3：绝不能把「缺少名单」理解为「允许全部」）。
 *
 *   unknown  大纲压根没有 cast 字段 —— 规划信息缺失，需要修复。
 *            行为：只投影主角（安全默认），并在 packet 里标出来。
 *   none     cast 明确是空数组 —— 作者要求本章无配角出场。
 *            行为：只投影主角。
 *   limited  cast 明确列出若干人物。
 *            行为：投影这些人物 + 主角。
 *
 * 另有一种独立情况：
 *   dangling cast 引用了不存在的实体 —— **阻断编译**，不静默忽略。
 */
export const CAST_STATUS = {
  UNKNOWN: 'unknown',
  NONE: 'none',
  LIMITED: 'limited',
}

function protagonistIds(project) {
  const s = new Set()
  for (const e of project.entities || []) {
    if (NEUTRAL_ROLE[String(e.authorRole || e.role || '')] === '主角') s.add(e.id)
  }
  return s
}

/**
 * 解析本章允许出场的实体 ID。
 * 返回 { status, ids, dangling }。调用方遇到 dangling 必须阻断。
 */
export function resolveCast(meta, project) {
  const entities = project.entities || []
  const prot = protagonistIds(project)
  const hasField = meta !== null && meta !== undefined && Array.isArray(meta.cast)

  // 情况一：压根没有 cast 字段
  if (!hasField) return { status: CAST_STATUS.UNKNOWN, ids: prot, dangling: [] }

  const raw = meta.cast.map((x) => String(x ?? '').trim()).filter(Boolean)

  // 情况二：明确为空数组
  if (!raw.length) return { status: CAST_STATUS.NONE, ids: prot, dangling: [] }

  // 情况三：明确列出
  const { byName } = buildEntityIndex(project)
  const ids = new Set(prot)
  const dangling = []
  for (const item of raw) {
    if (item.startsWith('ent_')) {
      if (entities.some((e) => e.id === item)) ids.add(item)
      else dangling.push(item)
    } else {
      const e = byName.get(item)
      if (e) ids.add(e.id)
      else dangling.push(item)
    }
  }
  return { status: CAST_STATUS.LIMITED, ids, dangling }
}

/* ------------------------------- 投影函数 ------------------------------- */

function projectCharacter(entity, allowed) {
  if (!entity) return null
  if (allowed && !allowed.has(entity.id)) return null

  const hasPublic = typeof entity.publicIdentity === 'string' && entity.publicIdentity !== ''
  const role = hasPublic
    ? String(entity.publicRole || '')
    : (() => {
        const n = NEUTRAL_ROLE[String(entity.authorRole || entity.role || '')] || ''
        return n === '相关人物' ? '' : n
      })()

  return {
    id: entity.id,
    name: entity.name,
    role,
    identity: hasPublic ? entity.publicIdentity : '',
    ...(hasPublic ? {} : { legacy: true }),
  }
}

/**
 * 投影伏笔：铺设阶段仅给 seed；回收阶段严格校验显式授权和历史已确认事件。
 * 绝不将原始 payoff 随普通计划条目传入正文，批准的 safeReveal 才允许披露。
 */
function projectForeshadows(project, meta) {
  const outline = project.outline || {}
  const acts = Array.isArray(meta?.foreshadows) ? meta.foreshadows : []
  const out = []
  const denied = []
  for (const a of acts) {
    const f = getForeshadow(project, String(a?.id || ''))
    if (!f || !['plant','reinforce','pay_off'].includes(a.action)) continue
    const seed = String(f.seed || '').trim()
    if (!seed) continue
    if (a.action !== 'pay_off') {
      out.push({ id: f.id, action: a.action, seed })
      continue
    }
    const verdict = revealDecision(project, meta, f)
    // payoff 作者真相可能包含角色根本不能知道的原因。只允许事先审核的安全呈现文本。
    if (verdict.allowed && f.safeReveal?.approved === true && typeof f.safeReveal?.text === 'string' && f.safeReveal.text.trim()) {
      out.push({ id: f.id, action: 'pay_off', seed, safeReveal: f.safeReveal.text.trim(), revealAuthorized: true })
    } else {
      denied.push({ id: f.id, reason: verdict.allowed ? 'no-approved-safe-projection' : verdict.reason })
      // 回收任务缺少必要授权，调用方应阻断而不是照常写、期待模型自己猜谜底。
    }
  }
  return { out, denied }
}

/** 角色秘密必须来自审核过的 safeProjection，而不是角色卡的原始 secret。 */
function projectEntityReveals(project, meta, castIds) {
  const accepted = []
  const denied = []
  for (const r of meta.reveals || []) {
    const e = (project.entities || []).find((x) => x.id === r.entityId)
    const projection = (e?.revealProjections || []).find((x) => x.id === r.projectionId)
    const prerequisites = [...(r.prerequisiteEventIds || []), ...(projection?.prerequisiteEventIds || [])]
    const events = [...(project.ledger?.foreshadowEvents || []), ...(project.ledger?.stateEvents || [])]
    const ready = prerequisites.every((id) => events.some((ev) => ev.id === id && ev.trust === 'canonical' &&
      (ev.status === 'accepted' || (ev.kind && ev.sourceVersion != null))))
    if (e && projection?.approved === true && r.approved === true && castIds.has(e.id) && ready &&
        Number(r.notBeforeChapter ?? meta.no) <= meta.no && String(projection.safeText || '').trim()) {
      accepted.push({ entityId: e.id, name: e.name, safeText: projection.safeText.trim(), projectionId: projection.id })
    } else denied.push({ entityId: r.entityId, reason: 'missing-approval-projection-prerequisite-or-cast' })
  }
  return { accepted, denied }
}

/** 作者侧情节概要不等于正文可读任务；缺授权字段就返回安全占位而不是裸透传。 */
function projectTask(meta) {
  const approved = meta.writerTaskApproval === 'author-approved'
  // 作者单章指令已经经过独立的 ChangeRequest 确认；拼到受控任务中，并继续接受 findLeaks 门禁。
  const instruction = String(meta.authorInstruction || '').trim()
  const base = approved ? String(meta.writerSummary || '') : '本章在既有冲突基础上推进人物行动，严格遵守已授权的线索和历史状态。'
  return {
    summary: instruction ? `${base}\n作者明确指定的本章要求：${instruction}` : base,
    goal: approved ? String(meta.writerGoal || '') : '完成本章可观察的局势变化，不自行披露未来身份与关键真相。',
    taskStatus: approved ? 'approved' : 'safe-fallback',
  }
}

/** 账本投影：存储层完整保留，这里只取当前相关、可信且未越界的一小部分 */
function projectLedger(project, entityIds, foreshadowIds, chapterNo, options = {}) {
  const { byId } = buildEntityIndex(project)
  const nameOf = (id) => byId.get(id)?.name || '（未知）'

  const ctx = selectContext(project, {
    chapterNo,
    entityIds: [...(entityIds || [])],
    foreshadowIds,
    requiredIds: options.requiredFactIds || [],
    budget: { maxFacts: options.maxFacts ?? 30, maxThreads: options.maxThreads ?? 20 },
  })

  // ⛔ 真实踩坑（v2.0.0 全量 30 章压测 · 主人指出）：
  //    上下文里**只给「尚未了结的线索」**，已了结的那一侧**一个字都不给**。
  //    ⇒ 模型不知道哪些线已经收尾 ⇒ 每章只顾着「新埋」（抽取提示词也只问「本章新埋下的线索」）
  //    ⇒ 实测：25 章累计 82 条线索**全部 open**，25 章只产出过 1 条 `resolved`。
  //    而上下文上限 20 条 + 排序按章号降序 ⇒ 第 1~19 章埋的线索**全被挤出上下文**，
  //    模型看不见它们 ⇒ 「前后矛盾」（主人三大痛点之一）。
  //    修法：把**已了结的线索 / 已回收的伏笔**单独拎成「已完成清单」送进提示词，
  //    让模型看得见「这些已经完事了 —— 不必再提、也不要重复引入」，
  //    从源头抑制线索无限膨胀。清单**限量**，否则它自己会变成新的膨胀源。
  const ledger = project.ledger || {}
  // ⛔ 真实事故（2026-10-13 审计，已在内存复现）：这条通道**自己实现了一遍过滤**，而且只看 status
  //    ⇒ 一条 `trust:'needsReview'`（或 `visibility:'secret'`）的线索，只要被置成
  //    `paid_off`/`abandoned`，它的**原文就会逐字进入正文提示词** ——
  //    「非 canonical 隔离」与「secret 永不进正文」两条声明同时失效。
  //    而 `findLeaks()` 根本不扫账本，所以**没有任何一层会报警**。
  //    （7 本真实作品里 needsReview 线索 5 条、legacy_unverified 14 条，任一被了结即触发。）
  //    修法：判据与 `selectContext` 共用同一处实现（`ledger.isWriterVisible`）。
  const closedThreads = (ledger.plotThreads || [])
    .filter((t) => t && t.text && (t.status === 'paid_off' || t.status === 'abandoned'))
    .filter((t) => isWriterVisible(t, { chapterNo }))
    .sort((a, b) => (b.sourceChapter || 0) - (a.sourceChapter || 0))
    .slice(0, options.maxClosedThreads ?? 8)
    .map((t) => t.text)
  // 只送 seed（表层线索），**绝不送 payoff（作者侧真相）** —— 与 findLeaks 的规则一致。
  const doneForeshadows = ((project.outline || {}).foreshadows || [])
    .filter((f) => f && f.lifecycle === 'paid_off')
    .slice(-8)
    .map((f) => `${f.id}：${String(f.seed || '').slice(0, 40)}`)

  return {
    facts: ctx.facts.map((f) => f.text),
    states: ctx.states.map((s) => `${nameOf(s.subjectId)}｜${s.attribute}：${s.value}`),
    knowledge: ctx.knowledge.map((k) => `${nameOf(k.characterId)}｜${k.belief === 'suspects' ? '怀疑' : k.belief === 'believes' ? '相信' : '知道'}：${k.fact}`),
    threads: ctx.threads.map((t) => t.text),
    closedThreads,
    doneForeshadows,
    diagnostics: { ...ctx.diagnostics, selected: { facts: ctx.facts.map((x) => x.id), states: ctx.states.map((x) => x.id), knowledge: ctx.knowledge.map((x) => x.id), threads: ctx.threads.map((x) => x.id) } },
  }
}

/* ------------------------------ 主投影入口 ------------------------------ */

export function buildWriterPacket(project, chapterNo, options = {}) {
  const outline = project.outline || {}
  const meta = findChapterMeta(outline, chapterNo)
  if (!meta) throw new Error(`第 ${chapterNo} 章不在大纲中。`)

  const castInfo = resolveCast(meta, project)
  // 悬空引用一律阻断：宁可这章写不了，也不能拿错误名单去生成
  if (castInfo.dangling.length) {
    throw new Error(
      `第 ${chapterNo} 章的出场名单引用了不存在的实体：${castInfo.dangling.join('、')}。请先修复大纲后再生成。`
    )
  }

  const cast = (project.entities || []).map((e) => projectCharacter(e, castInfo.ids)).filter(Boolean)

  const prev = (project.chapters || []).find((c) => c.no === chapterNo - 1)
  const recent = (project.chapters || []).filter((c) => c.no < chapterNo && c.summary).slice(-2)

  const { out: foreshadows, denied: deniedForeshadows } = projectForeshadows(project, meta)
  // 未授权的回收不能悄悄退化成普通场景，必须停下来补计划或披露审批。
  if (deniedForeshadows.length) {
    throw new Error(`第 ${chapterNo} 章伏笔回收尚未授权：${deniedForeshadows.map((x) => `${x.id}(${x.reason})`).join('、')}`)
  }
  const { accepted: authorizedReveals, denied: deniedReveals } = projectEntityReveals(project, meta, castInfo.ids)
  if (deniedReveals.length) throw new Error(`第 ${chapterNo} 章角色真相披露不满足授权或前置条件`)
  const taskProjection = projectTask(meta)
  /**
   * 全书进度 + 「是不是最后一章」。
   *
   * 为什么要有：① 模型需要知道自己在全书什么位置，才能校准节奏（第 2 章和第 28 章不该一个写法）；
   * ② 提示词里原本有一条**固定**的「结尾为下一章留下接口」—— 对**末章**是错的指令
   *    （会让模型在全书结尾处留一个假接口）。规矩要随位置变，所以位置必须算出来传给渲染层。
   */
  const totalChapters = Number(outline.totalChapters || project.targetChapters || 0) || null
  const progress = { no: Number(chapterNo), total: totalChapters }
  const isFinal = !!totalChapters && Number(chapterNo) >= totalChapters
  const ledger = projectLedger(project, castInfo.ids, foreshadows.map((f) => f.id), chapterNo, options)
  const { diagnostics: ledgerDiagnostics, ...contextAccounts } = ledger

  return {
    schemaVersion: 2,
    work: {
      title: project.title || '',
      genre: project.genre || '',
      // 不能把作者侧全书梗概/主题直接透传给第 1 章：可能含终局真相。
      logline: outline.publicLoglineApproved ? String(outline.readerLogline || '') : '沿当前人物处境与已公开冲突展开故事',
      theme: outline.publicThemeApproved ? String(outline.readerTheme || '') : '',
    },
    style: {
      base: writerStyleBase(project, outline),
      rules: [
        '情绪优先用动作与选择表现，不在段尾解释。',
        '对话承担试探与冲突，避免角色复述彼此已知的背景。',
      ],
    },
    cast,
    context: {
      prevTail: prev?.text ? tailSentences(prev.text, 420) : '',
      recentSummaries: recent.map((c) => ({ no: c.no, title: c.title, summary: c.summary })),
      ...contextAccounts,
      readerKnown: readerKnownProjections(project, chapterNo),
    },
    task: {
      no: meta.no,
      title: meta.title || '',
      summary: taskProjection.summary,
      goal: taskProjection.goal,
      volumeTitle: meta.volumeTitle || '',
      castIds: [...castInfo.ids],
      foreshadows,
      authorizedReveals,
      progress,
      isFinal,
    },
    constraints: {
      wordCount: options.wordCount || 2600,
      tolerancePct: 15,
    },
    // 诊断信息**不进入提示词**（renderWriterPacket 不读它），只供日志、界面与测试查看。
    // 任何一次剔除、隔离、截断都能在这里说出理由。
    diagnostics: {
      castStatus: castInfo.status,
      taskStatus: taskProjection.taskStatus,
      ...ledgerDiagnostics,
    },
  }
}

/* -------------------------------- 渲染层 -------------------------------- */

/**
 * 取「上一章结尾原文」——按**完整句子**取，而不是直接 `slice(-N)`。
 *
 * ⛔ 实测（新书《明日邮戳》第 2 章）：`slice(-420)` 把开头切成了半句 ——
 *    提示词里赫然是「……来，车头两盏灯在雪雾里晕开两团黄。」，那个开头的「来」是残句的尾巴。
 *    给模型一段开头就是残句的前情，它很容易顺着残句往下接。
 *    修法：从末尾按句末标点往回**整句累积**，攒够预算即停 ⇒ 首尾都是完整句子，
 *    长度只会略超预算（多出的是最前面那一句）。
 */
export function tailSentences(text, budget = 420) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (s.length <= budget) return s
  const parts = s.match(/[^。！？…\n]+[。！？…]*["'」』）)]?/g) || [s]
  let out = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    out = parts[i] + out
    if (out.length >= budget) break
  }
  // 兜底：万一有一句话长到离谱（整章无标点），不要让它把上下文撑爆
  return out.length > budget * 3 ? out.slice(-budget * 3) : out
}

function castBlock(cast, castStatus) {
  const lines = cast
    .map((c) => {
      const head = c.role ? `${c.name}（${c.role}）` : c.name
      return c.identity ? `· ${head}：${c.identity}` : `· ${head}`
    })
    .join('\n')

  // 名单缺失时，把「安全默认」明确写进提示词 —— 否则模型会自行补人
  const note =
    castStatus === CAST_STATUS.UNKNOWN
      ? '\n（本章未提供出场名单，只允许主角正式出场或介入剧情，不得引入其他有名有姓的人物。）'
      : castStatus === CAST_STATUS.NONE
        ? '\n（本章明确无配角出场。除了主角与已在【前情】中出现的人，不要新增人物。）'
        : ''

  return (lines || '（未指定）') + note
}

/**
 * 把投影阶段产生的诊断落成**可见的运行行为**。
 *
 * ⛔ 真实踩坑（v2.0.0 全量压测）：这个函数原先只在 `pipeline.generateChapter()` 里被调用，
 *    而那个函数**一个调用者都没有**（死代码，活路径是 `workflow.js`）⇒
 *    `chapter.contextNotes` 实测 **0/25 章** ⇒ 大纲页的「投影诊断」标记在真实章节上
 *    **永远不会出现**。「读路径接好了、写路径在另一条路上」这个病，本项目已是第三次。
 *    ⇒ 提到投影层（本模块），**由活路径 `workflow.js` 调用**，死路径与活路径共用同一实现。
 *
 * 不阻断生成，但必须留痕迹：日志 + 写入章节记录，界面可据此提示。
 */
export function collectContextNotes(chapterNo, d) {
  if (!d) return []
  const notes = []
  if (d.castStatus === 'unknown') {
    notes.push('本章出场名单缺失（规划信息不完整），已退化为只允许主角出场')
  }
  // ① packet.diagnostics 形态（把 summary 预生成的）—— 直接采用。
  for (const s of d.summary || []) notes.push(s)
  // ② manifest 形态（活路径 `workflow.js` 写入的是 compiled.manifest，没有 summary 字段）——
  //    从**投影真实发生的取舍**现场推导，保证两条路径的文案一致。
  if (!d.summary) {
    const fut = Object.values(d.futureSkipped || {}).reduce((n, x) => n + (Number(x) || 0), 0)
    if (fut > 0) notes.push(`已剔除 ${fut} 条未来章节的记录`)
    const q = Object.values(d.quarantined || {}).reduce((n, arr) => n + (arr?.length || 0), 0)
    if (q > 0) notes.push(`已隔离 ${q} 条来源不可信记录`)
    const dropped = (d.dropped?.facts?.droppedIds?.length || 0) + (d.dropped?.threads?.droppedIds?.length || 0)
    if (dropped > 0) notes.push(`超预算截断 ${dropped} 条`)
  }
  if (notes.length) console.warn(`[第 ${chapterNo} 章 · 上下文] ${notes.join('；')}`)
  return notes
}

function contextBlock(ctx) {
  const parts = []
  if (ctx.prevTail) parts.push(`【上一章结尾原文】\n……${ctx.prevTail}`)
  if (ctx.recentSummaries?.length) {
    parts.push(
      `【最近章节摘要】\n${ctx.recentSummaries
        .map((c) => `第 ${c.no} 章《${c.title}》：${c.summary}`)
        .join('\n')}`
    )
  }
  if (ctx.readerKnown?.length) parts.push(`【读者此前已知（不代表所有角色知道）】\n${ctx.readerKnown.map((t) => `· ${t}`).join('\n')}`)
  if (ctx.states?.length) parts.push(`【当前状态】\n${ctx.states.map((s) => `· ${s}`).join('\n')}`)
  if (ctx.knowledge?.length) {
    parts.push(`【角色已知信息】\n${ctx.knowledge.map((k) => `· ${k}`).join('\n')}`)
  }
  if (ctx.threads?.length) {
    parts.push(`【尚未了结的线索】\n${ctx.threads.map((t) => `· ${t}`).join('\n')}`)
  }
  // 「已完成清单」—— 与上面的「尚未了结」配对。给模型一个明确的**了结边界**：
  // 否则它会把已经收尾的线当悬案反复展开，或者换句话重复引入同一件事
  // （实测：没有这一侧时，82 条线索全部 open，模型越写越多、把早期线索挤出上下文）。
  if (ctx.closedThreads?.length || ctx.doneForeshadows?.length) {
    const done = [
      ...(ctx.closedThreads || []).map((t) => `· （已完成）${t}`),
      ...(ctx.doneForeshadows || []).map((f) => `· （已完成）${f}`),
    ]
    parts.push(
      `【已经了结的线索与伏笔】\n${done.join('\n')}\n`
      + '（以上都已收尾：「已完成」的内容不要再当作疑点重新展开，也不要换个说法再埋一次。）'
    )
  }
  if (ctx.facts?.length) parts.push(`【已确认的设定事实】\n${ctx.facts.map((f) => `· ${f}`).join('\n')}`)
  return parts.join('\n\n') || '（本章为开篇，无前情。）'
}

function foreshadowBlock(list) {
  if (!list?.length) return ''
  const label = { plant: '铺设', reinforce: '强化', pay_off: '回收' }
  const lines = list.map((f) => `· 〔${label[f.action] || f.action}〕${f.seed}${f.revealAuthorized ? `\n  本场景已批准披露：${f.safeReveal}` : ''}`)
  return `\n【本章需要处理的线索】\n${lines.join('\n')}\n（铺设/强化时不要解释真实含义；已批准的回收应按批准文本完成揭示。）\n`
}

/** 把 packet 渲染成提示词。这是正文提示词的唯一生成路径。 */
export function renderWriterPacket(packet) {
  const { work, style, cast, context, task, constraints, diagnostics } = packet
  const fBlock = foreshadowBlock(task.foreshadows)
  const revealBlock = task.authorizedReveals?.length ? `\n【本场景已授权披露】\n${task.authorizedReveals.map((r) => `· ${r.name}：${r.safeText}`).join('\n')}\n` : ''
  const castStatus = diagnostics?.castStatus

  return `【作品】《${work.title}》（${work.genre}）· ${work.logline}
【进度】第 ${task.progress?.no ?? 1} 章${task.progress?.total ? ` / 共 ${task.progress.total} 章` : '（总章数未定）'}${task.isFinal ? '（全书**最后一章**）' : ''}
【主题】${work.theme || '—'}

【文风规则】
${style.base}
${style.rules.map((r) => `· ${r}`).join('\n')}

【本章出场人物】
${castBlock(cast, castStatus)}
${fBlock}${revealBlock}
【前情】
${contextBlock(context)}

【本章任务】
章标题：${task.title}
概要：${task.summary || '—'}
目标（本章结束时应发生的变化）：${task.goal || '—'}

【写作要求】
1. 直接输出本章正文，第一个字就是小说内容本身。
2. 不要输出章标题、序号、任何说明或分隔线；不要复述上面的设定资料；不要写"本章讲述了……"。
3. 篇幅约 ${constraints.wordCount} 字，允许上下浮动 ${constraints.tolerancePct}%。
4. 必须与前情自然衔接，承接上一章结尾的动作、语气与指代。
5. 角色的一言一行必须符合其处境与动机；不要让角色做出违背动机的事。
6. 除【本场景已授权披露】外，只呈现可观察的表层动作与细节，不解释未授权的真实含义。
7. 只允许【本章出场人物】中列出的人物正式出场或介入剧情，其余人物至多一笔带过。
8. ${task.isFinal
    ? '这是**全书最后一章**：把已经铺设的线索收到位，不要留下悬而未决的线索，也不要预告后续。'
    : '结尾为下一章留下接口，但不要刻意制造悬念或强行总结。'}`
}

/** 正文调用的完整消息体，同样由 packet 派生 */
export function buildWriterMessages(packet) {
  return [
    {
      role: 'system',
      content: `你是一位极擅长${packet.work.genre}的长篇小说家，正在撰写《${packet.work.title}》的第 ${packet.task.no} 章。
你的文字自足成篇，读者只读正文，不读任何设定资料。`,
    },
    { role: 'user', content: renderWriterPacket(packet) },
  ]
}

/* ------------------------------ 泄漏自检 ------------------------------ */

/**
 * 泄漏自检用的片段 —— **分层**，别把两层混在一起。
 *
 * ⛔ 旧实现是 `split(标点).filter(s => s.length >= 8)`，两个毛病：
 *    ① 「长度 8」是**英文思维**（而且按含标点的原始字符算）：中文里 4 个实义字就能承载整个谜底
 *       （同一个病本项目犯过两次：`ledger` 的 `>=4 字` 误杀「不是。」、概要审查的 3 字 n-gram 刷噪音）；
 *    ② 只比**整句** ⇒ 换个标点就绕过，抄一半更是一点都查不到。
 *
 * 分工（这是**精度分工**，不是重复实现）：
 *   · **阻断层**（本函数，`findLeaks` 用它拒绝生成）：整句、去标点核心、长核心的 ≥`MIN_LEAK_GRAM`
 *     字连续片段。取 6 而不是 4，是因为 4~5 字的通用短语（「所有策略」「有一处秘密」）在正常
 *     上下文里也会出现，拿它阻断会让**章根本写不出来** —— 判据本身不可信时的高频误拒，
 *     等于把功能关掉（比漏报更糟）。
 *   · **诊断层**（`pipeline.auditWriterSummaries`）保留 3 字 n-gram：那批 4~5 字的可疑措辞
 *     落在那里 —— **提醒你，但不阻断**。
 *   · 两层都先过「公开面」过滤：seed 与角色公开信息天然是公开的，否则组织名天天误报。
 */
const MIN_LEAK_CORE = 4   // 实义字下限：整句 / 核心比较
const MIN_LEAK_GRAM = 6   // 连续片段下限：再短容易撞通用短语，交给诊断层
const leakCore = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '')

function leakFragments(text, publicSet) {
  const raw = String(text || '')
  const out = new Set()
  const keep = (s) => {
    const t = String(s || '').trim()
    if (t && !publicSet.has(t) && leakCore(t).length >= MIN_LEAK_CORE) out.add(t)
  }
  for (const clause of raw.split(/[，。；、：！？…,.;:!?\n]+/).map((s) => s.trim()).filter(Boolean)) {
    keep(clause)                 // 整句：措辞一致时最可靠
    keep(leakCore(clause))       // 去标点核心：换个标点也照样能对上
  }
  const whole = leakCore(raw)
  keep(whole)
  // 长核心切连续片段：抄了一半也要抓得住（只有 ≥6 实义字才切，见上面的理由）
  if (whole.length >= MIN_LEAK_GRAM) {
    for (let len = MIN_LEAK_GRAM; len <= Math.min(10, whole.length); len++) {
      for (let i = 0; i + len <= whole.length; i++) keep(whole.slice(i, i + len))
    }
  }
  return [...out]
}

/** 「公开面」：seed 与角色公开信息里出现过的片段不算秘密（与概要审查同一套降噪） */
function publicFragments(project) {
  const set = new Set()
  const add = (t) => { for (const f of leakFragments(t, new Set())) set.add(f) }
  for (const f of project?.outline?.foreshadows || []) add(f.seed)
  for (const e of project?.entities || []) {
    add([e.name, e.publicIdentity, e.publicRole, e.authorRole].filter(Boolean).join(' '))
  }
  return set
}

/**
 * 对 packet 做确定性泄漏检查，返回问题列表（空数组 = 干净）。
 * 提交前门禁与「确定性测试」共用同一套断言。
 */
export function findLeaks(packet, project) {
  const haystack = JSON.stringify(packet)
  const issues = []
  const outline = project.outline || {}
  const previouslyAuthorized = packet.context?.readerKnown || []
  const publicSet = publicFragments(project)
  /**
   * 去标点的干草堆：用于抓「同一句话被换了标点」。
   * ⚠️ 只在片段 ≥`MIN_LEAK_GRAM` 实义字时才用它 —— 去标点会把相邻 JSON 字段粘在一起，
   *    4~5 字的短片段很容易跨字段撞车，那会造成**误拒**（章写不出来）。
   */
  const hayCore = leakCore(haystack)
  const hit = (frag) => haystack.includes(frag)
    || (leakCore(frag).length >= MIN_LEAK_GRAM && hayCore.includes(leakCore(frag)))

  /**
   * 「已经公开的措辞」——**已定稿正文** + 一切**带出处**（`sourceChapter`）的账本条目。
   *
   * ⛔ 实测（2026-10-14 全流程首跑《三秒之后》）：第 3 章的投影被本函数拦死，3 条 entity-secret
   *    全是**误报**，而且片段在正文里逐字都不存在 —— 它们来自**记忆抽取的转述**：
   *      正文：「你能看见几秒之后的事」（林晚在病房问的）
   *      账本：`林晚｜知道：陈默自称能看见几秒后的事`   ← 抽取写的转述
   *      秘密：「她半年前…见过一个…醒来声称能看见几秒后画面的老人」← 措辞**恰好重合**
   *    而秘密的**主张**（她的经历、眼睛的来历）并不在 packet 里。拿「故事已经讲过的事」
   *    当成泄漏去拦下一章，结果是**这本书从此写不下去**（第 3 章永久 0 成本、也永远出不来）。
   *
   * 边界（这道豁免**只覆盖「文本已公开」**，不放宽真正的泄漏面）：
   *    · 仍会拦：片段只出现在 `task.summary` / `cast[].identity` / 作者侧字段里 —— 那才是
   *      「作者侧的真相被搬进了给正文看的提示词」，也正是本函数要防的东西。
   *    · 仍会拦：没有任何出处的账本条目（抽取幻觉出来的、来源不明的内容）。
   *    · 仍然豁免（原本就有）：`readerKnown`（作者已授权的披露）。
   */
  const textDerivedCore = (() => {
    const parts = []
    for (const c of project.chapters || []) {
      if (!c || c.status !== 'committed') continue
      parts.push(String(c.text || ''))
      // ⚠️ 章节**摘要**也算：它是提交时由抽取模型从正文里压出来的（`summary: e.summary`），
      //    所以措辞可能与正文不同、但**内容同源**。实测剩下的那条误报正卡在这里：
      //    正文写「埃及展图录…夹层里有一张底片」，摘要把同一件事压成「图录里的底片」，
      //    而它与角色秘密的措辞重合 ⇒ 若不豁免，这一章照样写不出来。
      parts.push(String(c.summary || ''))
    }
    for (const arr of Object.values(project.ledger || {})) {
      if (!Array.isArray(arr)) continue
      for (const it of arr) if (it && it.sourceChapter != null) parts.push(JSON.stringify(it))
    }
    return leakCore(parts.join('\n'))
  })()
  const alreadyPublic = (frag) => {
    const c = leakCore(frag)
    return c.length >= MIN_LEAK_CORE && textDerivedCore.includes(c)
  }

  // 1) 实体秘密不得出现：获批的安全表层文本属于例外，但不等于原始 secret 获批。
  for (const e of project.entities || []) {
    const secret = String(e.secret || '')
    if (!secret) continue
    for (const frag of leakFragments(secret, publicSet)) {
      if (hit(frag) && !alreadyPublic(frag) && !(packet.task.authorizedReveals || []).some((r) => r.safeText.includes(frag)) && !previouslyAuthorized.some((t) => t.includes(frag))) {
        issues.push({ type: 'entity-secret', target: e.name, fragment: frag })
      }
    }
    // 整条原样出现是最强信号（也兜住比 MIN_LEAK_CORE 还短的秘密）；
    // 但若这条「秘密」本身就在公开面里（例如与 seed 一字不差），那它不是秘密 —— 不报。
    if (!publicSet.has(secret) && haystack.includes(secret) && !(packet.task.authorizedReveals || []).some((r) => r.safeText.includes(secret)) && !previouslyAuthorized.some((t) => t.includes(secret))) {
      issues.push({ type: 'entity-secret-full', target: e.name, fragment: secret.slice(0, 40) })
    }
  }

  // 2) 非本章的章节概要不得出现
  for (const ch of allChapters(outline)) {
    if (ch.no === packet.task.no) continue
    const s = String(ch.summary || '')
    if (s.length >= 12 && haystack.includes(s)) {
      issues.push({ type: 'other-chapter-summary', target: `第 ${ch.no} 章`, fragment: s })
    }
  }

  // 3) 伏笔的真实含义不得出现
  for (const f of outline.foreshadows || []) {
    for (const frag of leakFragments(f.payoff, publicSet)) {
      if (hit(frag) && !alreadyPublic(frag) && !(packet.task.foreshadows || []).some((r) => r.revealAuthorized && r.safeReveal.includes(frag)) && !previouslyAuthorized.some((t) => t.includes(frag))) {
        issues.push({ type: 'foreshadow-payoff', target: String(f.id || ''), fragment: frag })
      }
    }
  }

  // 4) 作者侧定位不得作为公开定位出现
  for (const c of packet.cast) {
    if (c.role === '对手' || c.role === '反派') {
      issues.push({ type: 'author-role-leak', target: c.name, fragment: c.role })
    }
  }

  return issues
}
