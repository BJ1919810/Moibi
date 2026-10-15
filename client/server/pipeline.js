/**
 * 生成流水线：大纲 → 逐章正文 → 记忆提取 → 落账。
 *
 * 信息边界（第 1 轮评审 P0-1A）：
 *   正文提示词的唯一来源是 projection.buildWriterMessages(packet)。
 *   本模块不得自行拼接任何角色、状态、摘要数据。
 *   生成前跑确定性泄漏自检，不通过直接阻断。
 *
 * 状态账本（第 1 轮评审 P0-1B）：
 *   提取结果经 ledger.applyExtraction 落进四类账本，
 *   存储层不截断，上下文层在 projection 里按相关性挑选。
 *
 * 思考模式的取舍（全系统统一原则：思考能力是**用户配置**，
 * 不是某个业务流程偷偷覆盖的内部策略）：
 *   大纲 → 跟随设置页的「深度思考」开关，默认关闭；开启时额外预留输出预算；
 *   正文量大、逐章累加 → 跟随配置，默认关闭；
 *   记忆提取是机械抽取 → 固定关闭。
 */
import { chat } from './providers/openai.js'
import * as store from './store.js'
import { outlineMessages, extractMessages, settingsFillMessages, DEFAULT_WORD_COUNT } from './prompts.js'
// cast 名字→实体 ID 的归一**只有一份**（schema.normalizeCastIds）：开书路径原来自己写了一句
// `nameToId.get(trim(n)) + filter(Boolean)` —— 零 canon、零别名、还静默丢人（重排路径却写对了）。
import { normalizeCastIds } from './schema.js'
import { buildWriterPacket, buildWriterMessages, findLeaks, collectContextNotes } from './projection.js'
import { entityId, makeEntity, contentFingerprint, stripChapterTitlePrefix, normalizeForeshadowAction, stripFence, cleanBody } from './schema.js'
import { validateChapterCount, outlinePlanCount } from './creative-options.js'
import { ensureLedger, applyExtraction, makeNameResolver, applyLearnedAliases } from './ledger.js'
import { recordForeshadowEvidence, recordEntityRevealEvidence, normalizeForeshadows } from './foreshadow.js'

/* ------------------------------- 工具函数 ------------------------------- */

// ⛔ `stripFence` / `cleanBody` 已收进 `schema.js`（唯一实现）。
//    这里原来各有一份 —— 而 `cleanBody` 那份**只被下面那条死出口用到**，活路径反而没有，
//    于是模型爱加的开头（「第一章 …」「以下是正文：」「---」）曾经能直接落进正式正文。

function parseJSON(text) {
  const cleaned = stripFence(text)
  try {
    return JSON.parse(cleaned)
  } catch {
    /* 继续尝试截取 */
  }
  const i = cleaned.indexOf('{')
  const j = cleaned.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(cleaned.slice(i, j + 1))
    } catch {
      /* 落到下面抛错 */
    }
  }
  throw new Error('模型返回的内容不是合法 JSON，请重试或更换模型。')
}

function accUsage(project, usage) {
  if (!project.usage) {
    project.usage = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  }
  project.usage.calls += 1
  project.usage.inputTokens += usage?.inputTokens || 0
  project.usage.outputTokens += usage?.outputTokens || 0
  project.usage.reasoningTokens += usage?.reasoningTokens || 0
}

// `countWords` 随那条死出口 `generateChapter` 一起删掉了（它只被那里用到）。
// 活路径 `workflow.js` 是现算的：`String(draft.text).replace(/\s/g,'').length`。

/* ------------------------------- 大纲生成 ------------------------------- */

/** 从 cast 建立实体表，并返回「名字 → 实体 ID」映射 */
function buildEntitiesFromCast(cast) {
  const entities = []
  const nameToId = new Map()
  for (const c of cast || []) {
    const name = String(c?.name || '').trim()
    if (!name) continue
    const id = entityId('character', name)
    nameToId.set(name, id)
    entities.push(
      makeEntity({
        kind: 'character',
        name,
        publicRole: String(c?.publicRole || ''),
        publicIdentity: String(c?.publicIdentity || ''),
        authorRole: String(c?.authorRole || c?.role || ''),
        secret: c?.secret ? String(c.secret) : null,
        want: String(c?.want || ''),
        fear: String(c?.fear || ''),
        // v1 角色卡增强字段：作者侧保存，正文仍仅投影既有公开字段。
        characterCard: Object.fromEntries(['gender','age','appearance','personality','motivation','arc','relationships','abilities','status','highlight'].map((k) => [k, k === 'relationships' ? (Array.isArray(c?.[k]) ? c[k] : []) : String(c?.[k] ?? '')])),
      })
    )
  }
  return { entities, nameToId }
}

/** 合并实体：同 ID 以新数据为准，但保留既有别名与创建时间 */
function mergeEntities(project, incoming) {
  const map = new Map((project.entities || []).map((e) => [e.id, e]))
  for (const e of incoming) {
    const old = map.get(e.id)
    if (old) {
      map.set(e.id, {
        ...old,
        ...e,
        aliases: [...new Set([...(old.aliases || []), ...(e.aliases || [])])],
        createdAt: old.createdAt || e.createdAt,
      })
    } else {
      map.set(e.id, e)
    }
  }
  project.entities = [...map.values()]
}

/**
 * 章节概要审查：检查 `writerSummary` / `writerGoal` 有没有把**伏笔的回收真相（payoff）**
 * 抄进表层文本。
 *
 * 为什么只查 payoff、不查 secret：
 *   · payoff 的语义边界最清楚 —— seed 是给正文的线索，payoff 是谜底，谜底绝不该出现在表层。
 *   · secret 里大量名词（旧部志、学生会、观察部）本就是场景道具与公开组织，查它必然高误报。
 *   · 实测也证明：字符级 n-gram 重合度**区分不了**「妹妹 ↔ 姐姐」这种关系反转
 *     （秘密写「她是凛的妹妹」，概要写「姐姐讨厌雨天」，重合度是 0.000），
 *     所以不做相似度猜测，只做**可解释的词项命中**。
 *
 * 三条降噪规则（每条都是减法，可逐条解释，不做语义推断）：
 *   ① 命中的片段必须**不在任何 seed 里出现** —— seed 的措辞本就允许给表层用。
 *      （跨伏笔减，不只减自己那条：别的伏笔的 seed 词也是公开的。）
 *   ② 剔掉以虚词开头/结尾的片段（「旧部志的」「自己的」「的不完美」），它们不承载真相。
 *   ③ 剔掉出现在角色**公开信息**（name / publicIdentity / publicRole）里的片段，
 *      如「学生会」「观察部」—— 公开组织不是谜底。
 *
 * 实测（真作品 p_b4aebdfef1c9，5 条伏笔 × 29 章）：
 *   不做降噪 → 7 条命中，其中 6 条是噪声；
 *   三条全上 → 收敛到 2 条，其中「第4章 f3 雨天走廊」是人工确认的真实泄露。
 *
 * 纯函数、不抛错：返回 issue 列表，由调用方决定怎么处理（当前是降级为诊断，不阻断）。
 *
 * @returns {Array<{chapterNo:number, foreshadowId:string, fragment:string}>}
 */
export function auditWriterSummaries(volumes, foreshadows, project = null) {
  const fs = (foreshadows || []).filter((f) => String(f?.payoff || '').trim())
  if (!fs.length) return []
  const issues = []

  // 只取「连续汉字/字母数字」的长片段，标点与空白会把词切碎，反而漏掉长词。
  const segments = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ').split(/\s+/).filter(Boolean)
  const snippets = (s) => {
    const out = new Set()
    for (const seg of segments(s)) {
      // 3~8 字：短于 3 字噪声太大，长于 8 字几乎不会原样复现
      for (let len = 3; len <= 8; len++) {
        for (let i = 0; i + len <= seg.length; i++) out.add(seg.slice(i, i + len))
      }
    }
    return out
  }
  // 规则 ②：虚词开头 / 结尾的片段不承载真相
  const VIRTUAL_HEAD = /^(的|了|是|在|和|与|也|都|就|又|而|但|却|把|被|让|给|对|从|向|为|以|之|其|这|那|不|很|最|一)/
  const VIRTUAL_TAIL = /(的|了|是|和|与|在|之|其|而|但|却|也|都|就|又|把|被|让|给|对|从|向|为|以|着|过)$/
  const isVirtual = (w) => VIRTUAL_HEAD.test(w) || VIRTUAL_TAIL.test(w)

  // 规则 ①：所有 seed 的片段全集（公开措辞）
  const publicFromSeeds = new Set()
  for (const f of fs) for (const s of snippets(f.seed)) publicFromSeeds.add(s)
  // 规则 ③：角色公开信息里的片段（公开组织 / 公开身份）
  const publicFromCast = new Set()
  for (const e of project?.entities || []) {
    for (const s of snippets([e.name, e.publicIdentity, e.publicRole, e.authorRole].filter(Boolean).join(' '))) {
      publicFromCast.add(s)
    }
  }

  const chapterList = (volumes || []).flatMap((v) => v?.chapters || [])
  for (const f of fs) {
    const payoffOnly = new Set()
    for (const s of snippets(f.payoff)) {
      if (publicFromSeeds.has(s) || publicFromCast.has(s) || isVirtual(s)) continue
      payoffOnly.add(s)
    }
    if (!payoffOnly.size) continue
    for (const c of chapterList) {
      /**
       * 豁免：**真相已经（或即将在本章）公开**的章节不算提前泄露。
       *
       * ⛔ 实测（2026-10-14，新书《明日邮戳》window 重排后）：这条诊断把 5 条全报了出来，
       *    其中 3 条正是**回收章本身**（ch7 回收 f3、ch9 回收 f1/f5）—— 而那些章的剧情
       *    就是「把真相说出来」，报它等于每次重排都刷一遍噪音，把真正要看的那条淹掉。
       *    判据：`本章章号 >= 该伏笔的回收章` ⇒ 真相在这一章或更早已经公开。
       *    （回收章在未授权时**整章会被门禁拦死**，所以也不存在「靠概要偷偷泄底」的路径。）
       *    ⚠️ 回收章未确认（null）时**仍然报** —— 那是「关联待审核」，本来就该让人看一眼。
       */
      const payoffNo = Number(f.payoffChapter ?? f.revealAt ?? 0) || 0
      if (payoffNo && Number(c?.no) >= payoffNo) continue
      const haystack = `${c?.writerSummary || ''} ${c?.writerGoal || ''}`
      if (!haystack.trim()) continue
      for (const frag of payoffOnly) {
        if (haystack.includes(frag)) {
          // 并列给出**两边的出处**：只说「概要里有『秘密基地』」，作者没法判断是真泄漏还是噪音；
          // 把 payoff 里对应的那一段与重叠字数一起给出，5 秒就能判 —— 这是这条诊断最关键的可判性。
          const at = String(f.payoff || '').indexOf(frag)
          const around = at >= 0
            ? String(f.payoff).slice(Math.max(0, at - 8), at + frag.length + 8)
            : ''
          issues.push({ chapterNo: Number(c?.no) || null, foreshadowId: String(f.id || ''), fragment: frag,
            payoffAround: around, overlap: frag.length })
        }
      }
    }
  }
  // 同一章 + 同一伏笔只报最长的那一条（短的往往是长的子串）
  const best = new Map()
  for (const it of issues) {
    const key = `${it.chapterNo}|${it.foreshadowId}`
    const prev = best.get(key)
    if (!prev || it.fragment.length > prev.fragment.length) best.set(key, it)
  }
  return [...best.values()].sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0))
}

/**
 * 把概要审查结果转成**给人看的**诊断文案。
 *
 * 只做描述，不替作者下结论 —— 判据有边界命中（例如「观察记录」这类公开概念），
 * 所以措辞是「可能」，并明确告知**下一步能做什么**。绝不静默、也绝不自动改数据。
 *
 * ⚠️ 处理建议必须**指向真实存在的出口**。此前这里写的是「去伏笔页改写 payoff」——
 *    当时那确实是唯一能改的东西（TABS 只有主题/三幕/角色卡/世界观/伏笔/设置，没有章节分区）。
 *    2026-10-14 起「执笔页 → 本章写作任务 → 编辑」可以改 `writerSummary/writerGoal`
 *    （ChangeRequest kind `chapter_task_text`），所以建议改成指向它 —— 那才是真正能修的地方：
 *    **泄漏在表层概要里，改 payoff 修不掉它。**
 */
/** 重叠不超过这么多字时标为「弱信号」：机制词与通用名词多半落在这个区间（见下面 sort 处的实测记录） */
export const WEAK_OVERLAP = 4
export function outlineAuditNotes(audit, project) {
  if (!Array.isArray(audit) || !audit.length) return []
  const fsLabel = (id) => {
    const f = (project?.outline?.foreshadows || []).find((x) => x.id === id)
    // 伏笔没有名字，用 seed 的前 26 字当识别符，作者能对上号
    return f?.seed ? `伏笔「${String(f.seed).slice(0, 26)}」` : `伏笔 ${id}`
  }
  const byChapter = new Map()
  for (const i of audit) {
    if (!byChapter.has(i.chapterNo)) byChapter.set(i.chapterNo, [])
    byChapter.get(i.chapterNo).push(i)
  }
  const notes = []
  for (const [no, items] of byChapter) {
    /**
     * 先看强信号：按**重叠字数**降序。
     * ⛔ 实测（2026-10-14，新书《明天的邮戳》中段 window 重排）：这份诊断报了 5 条，
     *    全部是 3~4 字的重叠，而且全是**机制词/通用词**（「收件人」「年轻时」「经营业厅」「无主信并」）——
     *    一条真相陈述都没有。根因：payoff 里本身就嵌着机制说明（"信件不经营业厅"这种），
     *    而前段剧情**必须**能提机制，否则写不下去。
     *    ⇒ 3~4 字的重叠落在「可能真、也可能只是共用措辞」的灰区，必须标出来并排到后面，
     *      否则真问题（5 字以上的实质措辞）会被这种噪音淹掉。
     */
    items.sort((a, b) => (b.overlap || 0) - (a.overlap || 0))
    const detail = items.map((i) => {
      const around = i.payoffAround ? `（回收真相里对应的是「…${i.payoffAround}…」，重叠 ${i.overlap} 字）` : ''
      const weak = (i.overlap || 0) <= WEAK_OVERLAP
      return `${fsLabel(i.foreshadowId)}的片段「${i.fragment}」${around}${weak ? '〔弱信号：可能只是共用措辞〕' : ''}`
    }).join('；')
    const hasStrong = items.some((i) => (i.overlap || 0) > WEAK_OVERLAP)
    notes.push(`第 ${no} 章的表层概要含有 ${detail}。` +
      (hasStrong
        ? '这可能把回收真相写成了正文可见内容；'
        : '这些重叠都很短，多半只是**共用措辞**（机制说明、通用名词），不一定是泄露；') +
      `本章概要已保留原样，**不阻断生成、也不自动改写**。` +
      `要改的话：去「执笔页 → 本章写作任务 → 编辑」把这一章的写作任务改成不含真相措辞的说法` +
      `（那里也能看到改动前后的对比）。若判断只是措辞巧合，可以不动。`)
  }
  return notes
}

/**
 * 规范化大纲：公开信息与作者信息显式分开存放。
 * 章节 cast 由名字改写为实体 ID，与名字解耦（改名后关联不失效）。
 */
export function normalizeOutline(raw, targetChapters = null) {
  const acts = Array.isArray(raw?.acts) ? raw.acts : []
  const rawCast = Array.isArray(raw?.cast) ? raw.cast : []
  const { entities, nameToId } = buildEntitiesFromCast(rawCast)
  if (!entities.length) throw new Error('大纲缺少有效角色设定，不能标记为成功')

  const cast = rawCast
    .map((c) => {
      const name = String(c?.name || '').trim()
      if (!name) return null
      return { name, entityId: nameToId.get(name) || null }
    })
    .filter(Boolean)

  const foreshadows = (Array.isArray(raw?.foreshadows) ? raw.foreshadows : []).map((f, i) => ({
    id: String(f?.id || `f${i + 1}`),
    seed: String(f?.seed || ''),
    payoff: String(f?.payoff || ''),
    plantAt: Number(f?.plantAt) || null,
    revealAt: Number(f?.revealAt) || null,
    plantChapter: Number(f?.plantAt) || null,
    payoffChapter: Number(f?.revealAt) || null,
    linkStatus: 'explicit', // 新生成大纲的计划坐标，非实际铺设证据
    prerequisiteEventIds: [],
    lifecycle: 'approved',
  }))

  // 三幕之外保留全书卷级里程碑，独立于当前 3～5 章细节窗口。
  const volumeMilestones = (Array.isArray(raw?.volumes) ? raw.volumes : [])
    .map((v,vi) => ({ title: String(v?.title || `第 ${vi+1} 卷`), goal:String(v?.goal || '') }))
  let no = 0
  let volumes = (Array.isArray(raw?.volumes) ? raw.volumes : []).map((v, vi) => ({
    title: String(v?.title || `第 ${vi + 1} 卷`),
    goal: String(v?.goal || ''),
    chapters: (Array.isArray(v?.chapters) ? v.chapters : [])
      .filter(c => c && typeof c === 'object' && !Array.isArray(c) &&
        [c.title,c.summary,c.goal,c.writerSummary,c.writerGoal].some(x => typeof x === 'string' && x.trim()))
      .map((c) => {
      no += 1
      return {
        no,
        // 模型常自带「第一章」前缀；UI 会另加「第 N 章」⇒ 在此剥掉，避免序号重复两遍。
        title: stripChapterTitlePrefix(c?.title) || `第 ${no} 章`,
        summary: String(c?.summary || ''),
        goal: String(c?.goal || ''),
        writerSummary: String(c?.writerSummary || ''),
        writerGoal: String(c?.writerGoal || ''),
        // ⛔ 不能采信模型自报的批准位（2026-10-13 审计）：模型只要在 JSON 里写
        //    `author-approved`，它**自己产出的**作者侧 writerSummary/writerGoal 就会被当作
        //    「已批准的正文任务」拼进正文提示词（projection.projectTask），而这里没有任何人工批准
        //    ⇒ 「必须作者批准才进正文」形同虚设（且 findLeaks 不查 characterCard）。
        //    与 pay_off / reveals 同一条纪律：模型产物一律 proposed，批准只能由作者显式写入。
        writerTaskApproval: 'proposed',
        reveals: [], // 新生成模型不能自行批准私密身份释放，等待规划/作者授权
        // ⛔ 原来这里是 `nameToId.get(String(n).trim())` + `.filter(Boolean)`：零 canon、零别名、
        //    还**静默丢人**（重排路径的同一判据却有 canon/别名/告警）。现在共用唯一实现，
        //    并把认不出来的名字记在章节上（`castUnresolved`）⇒ 由 workflow 变成大纲页上看得见的标记。
        ...(() => {
          const r = normalizeCastIds(c?.cast, { entities }, [])
          return { cast: r.ids, castUnresolved: r.unresolved }
        })(),
        castSource: 'from-outline',
        // ⛔ 这里曾经**零归一、零白名单**，还按**原始串**判 approved —— 两处都是同一个病：
        //    模型把铺设写成「埋设」⇒ 原样存进 outline ⇒ 消费端 `projectForeshadows()` 只认
        //    plant/reinforce/pay_off，于是**静默丢弃** ⇒ 该章没有 plant 指令 ⇒ 抽取侧不要求埋设
        //    ⇒ 账本没有 plant 事件 ⇒ 回收章判 `not-planted` ⇒ **那一章永久写不出来**（¥0）。
        //    原始串比较还留了个自批准的口子（写 `payoff` 会落到 approved:true）。
        //    修法：与重排路径共用 `schema.normalizeForeshadowAction`，approved 按**归一后**的动作判。
        foreshadows: Array.isArray(c?.foreshadows)
          ? c.foreshadows
              .map((f) => {
                const action = normalizeForeshadowAction(f?.action)
                return { id: String(f?.id || '').trim(), action, approved: action !== 'pay_off' }
              })
              .filter((f) => f.id && f.action)
          : [],
      }
    }),
  }))

  const target = validateChapterCount(targetChapters ?? no)
  const window = outlinePlanCount(target)
  const minimum = Math.min(target, Math.max(1, window - 2))
  // P1：模型返回是内容规划，不是精确计数。允许 3～5 章自然波动（短篇按目标章数）。
  // 不能让无卷/空章或大段空白计划通过：否则作品被标记为成功而首章不可写。
  if (no < minimum) throw new Error(`大纲仅返回 ${no} 章有效规划，至少需要 ${minimum} 章；请重试`)
  if (!volumes.some(v => v.chapters.length)) throw new Error('大纲没有可用的章节规划')
  // 模型经常一次返回十几章（提示词说的是「建议开篇约 N 章，允许 3～5 章浮动」，
  // 它对「建议」并不严格）。这些额外的章节是**已经付过费的完整规划**，
  // 旧的 `no > window ⇒ 直接砍掉多余章节」把它们全丢了 —— 一次白花。
  // 现在的做法：**保留前 window 章为已细化**，多出来的部分降级成「已带内容的占位」，
  // 既不浪费已生成的内容，也不破坏「远期不能提前定稿」的门禁
  // （占位仍带 pendingDetail，写之前必须走滚动细化，届时会被模型重新审视）。
  //
  // 占位统一走 pushPlaceholder，两个必须守住的点：
  //   ① 占位**只能进「滚动规划」卷**：不能让它们落进模型给的剧情卷里
  //      （否则「第一卷」会同时装着已细化正文计划和一串「待细化」，卷语义混乱）。
  //   ② 卷号**按已存在的滚动规划卷计数**，不能用 n 反推 —— 溢出章节可能已经建过
  //      一个「滚动规划 1」，反推会造出第二个同名卷。
  const rollingCount = () => volumes.filter((v) => /^滚动规划/.test(String(v.title || ''))).length
  const openRollingVolume = () => volumes.push({ title: `滚动规划 ${rollingCount() + 1}`, goal: '待结合已确认正文细化', chapters: [] })
  const pushPlaceholder = (chapter) => {
    const last = volumes[volumes.length - 1]
    if (!last || !/^滚动规划/.test(String(last.title || ''))) openRollingVolume()
    // 每卷最多 12 章，超了另起一卷，保证侧栏大纲不会出现超长卷
    else if (last.chapters.length >= 12) openRollingVolume()
    volumes[volumes.length - 1].chapters.push(chapter)
  }

  if (no > window) {
    let retained = 0
    const overflow = []
    volumes = volumes.map(v => ({ ...v, chapters: v.chapters.filter((c) => {
      if (++retained <= window) return true
      overflow.push(c)
      return false
    }) })).filter(v => v.chapters.length)
    no = window
    for (const c of overflow) {
      // 内容保留，但仍是「待细化」：author 可见为草稿规划，正文门禁照样拦。
      // 模型自报的伏笔动作未经过位置校验，降级为占位时不再作为当前指令。
      pushPlaceholder({ ...c, pendingDetail: true, castSource: 'model-overflow', foreshadows: [] })
    }
  }

  // 大型作品只给当前窗口详细计划，剩余章以纯占位描述保存。
  // 占位不得成为已确认剧情，未来写作仍需滚动 L2 细化与披露门禁。
  const filled = volumes.reduce((n, v) => n + v.chapters.length, 0)
  if (target > filled) {
    for (let n = filled + 1; n <= target; n++) {
      pushPlaceholder({
        // 标题不带章号：UI 统一在章名前加「第 N 章」，此处再带一遍就是重复。
        no: n, title: '待细化', summary: '', goal: '', writerSummary: '',
        writerGoal: '', writerTaskApproval: 'proposed', cast: [], castSource: 'rolling-placeholder',
        foreshadows: [], reveals: [], pendingDetail: true,
      })
    }
  }
  // 章节概要审查：模型可能把伏笔的回收真相（payoff）改写后抄进 writerSummary。
  // 这一步**在落盘前跑**（而不是等生成正文时才发现），把可疑命中记成非致命诊断。
  // 不阻断生成：这批规划已经付过费，且判据本身有边界命中，交由作者判断。
  const summaryAudit = auditWriterSummaries(volumes, foreshadows, { entities })
  return {
    outline: {
      title: String(raw?.title || '').slice(0, 20),
      logline: String(raw?.logline || ''),
      readerLogline: String(raw?.readerLogline || ''),
      readerTheme: String(raw?.readerTheme || ''),
      publicLoglineApproved: false,
      publicThemeApproved: false,
      theme: String(raw?.theme || ''),
      worldview: String(raw?.worldview || ''),
      style: String(raw?.style || ''),
      // 模型在大纲里一并生成的作者偏好（核心目标/禁止描写/结局偏好/主角设定）。
      // 仅作为「补齐候选」，真正落盘时按 applyGeneratedPreferences 的规则合并。
      preferences: (raw?.preferences && typeof raw.preferences === 'object' && !Array.isArray(raw.preferences))
        ? Object.fromEntries(Object.entries(raw.preferences)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, String(v).trim()]))
        : {},
      acts,
      cast,
      foreshadows,
      summaryAudit,
      volumeMilestones,
      volumes,
      totalChapters: target,
      planningMode: target > no ? 'rolling' : 'complete',
      plannedDetailThrough: no,
    },
    entities,
  }
}

/**
 * 大纲调用的思考策略（P0 修复）。
 *
 * 历史 bug：这里曾**硬编码 `thinking: true`**，绕过设置页开关。当所用模型
 * （如 deepseek-flash）默认自带思考时，输出预算会被 reasoning 全部吃光，
 * 正文一个字都不剩 → 大纲返回空 → 后续所有章节因「找不到章节规划」失败。
 *
 * 现改为严格跟随 `cfg.thinking`（只有 === true 才算开启，杜绝字符串/真值误判），
 * 开启思考时为 reasoning 额外预留输出空间，避免它挤占正文预算。
 * 抽成纯函数便于零成本单测（不需要真实调用模型）。
 */
export function outlineThinkingParams(cfg = {}) {
  const wantThinking = cfg?.thinking === true
  return {
    thinking: wantThinking,
    maxTokens: wantThinking ? 20480 : 8192,
  }
}

/** 判定一个模型字段是否为「有实义的内容」——空串与常见占位词都不算。 */
export const PLACEHOLDERS = /^(?:null|none|n\/a|待定|暂无|略|同上|未提供|未填写|由用户决定|稍后补充|无|—|-|\.+)?$/i
export function isMeaningful(v) {
  const s = String(v ?? '').trim()
  return Boolean(s) && !PLACEHOLDERS.test(s)
}

/**
 * 世界观落盘策略（纯函数，便于零成本单测）。
 *
 * 用户手填的 authorWorldRules 是作者意图，**任何情况下都不能被模型输出覆盖**；
 * 用户没填时，用大纲模型生成的公开世界观自动补齐 —— 这样「世界观」在开书后
 * 就有内容，不需要用户从空白框手敲。
 */
export function applyGeneratedWorldview(project, outline) {
  if (String(project.authorWorldRules || '').trim()) return project
  const generated = outline?.worldview
  if (isMeaningful(generated)) project.authorWorldRules = String(generated).trim()
  return project
}

/**
 * 作者偏好自动补齐（纯函数，便于零成本单测）。
 *
 * 开书页只让用户填「灵感／题材／篇幅／文风」，其余偏好（核心目标、禁止描写、
 * 结局偏好、主角设定）没有输入入口 —— 若模型也没给，这些字段就永远是空的。
 * 这里把模型在大纲里返回的 preferences 落盘：**只补用户没填过的字段**，
 * 用户填过的一律不覆盖（preferenceSources === 'user' 表示用户来源）。
 *
 * 文风特殊：旧版创书页把文风存在 `preferences.style`，而抽屉读的是
 * `preferences.styleSpec` ⇒ 抽屉永远显示空。这里统一把用户文风提升到
 * `styleSpec`（不删旧的 style，保持历史兼容），模型生成的 style 也一并回填。
 */
export const GENERATED_PREF_KEYS = ['coreGoal', 'forbidden', 'ending', 'protagonist']

export function applyGeneratedPreferences(project, outline) {
  project.preferences ||= {}
  project.preferenceSources ||= {}
  const prefs = project.preferences
  const srcs = project.preferenceSources
  const userHas = (k) => srcs[k] === 'user' && isMeaningful(prefs[k])
  const setFromModel = (key, value) => {
    if (!isMeaningful(value)) return false
    if (userHas(key)) return false
    prefs[key] = String(value).trim()
    srcs[key] = 'outline'
    return true
  }

  // ① 文风：用户填过 style（旧键名）但没填 styleSpec ⇒ 提升，抽屉才读得到。
  if (!userHas('styleSpec') && isMeaningful(prefs.style)) {
    prefs.styleSpec = String(prefs.style).trim()
    srcs.styleSpec = srcs.style || 'user'
  }
  // ② 文风：用户完全没填 ⇒ 用模型在大纲里给的 style 回填。
  if (!isMeaningful(prefs.styleSpec) && !isMeaningful(prefs.style)) {
    setFromModel('styleSpec', outline?.style)
  }

  // ③ 其余作者偏好：模型在大纲 preferences 里返回什么就补什么，用户填过的不动。
  const generated = outline?.preferences || {}
  for (const key of GENERATED_PREF_KEYS) setFromModel(key, generated[key])
  return project
}

/**
 * 列出「设定层」里仍然空缺的字段（纯函数，便于零成本单测）。
 * 用于判断要不要再跑一次补全调用 —— 全都齐了就一次都不多花。
 */
export function missingSettingFields(project) {
  const prefs = project?.preferences || {}
  const srcs = project?.preferenceSources || {}
  const missing = []
  if (!isMeaningful(project?.authorWorldRules)) missing.push('worldview')
  if (!isMeaningful(prefs.styleSpec) && !isMeaningful(prefs.style)) missing.push('style')
  for (const key of GENERATED_PREF_KEYS) {
    // 用户手填过（哪怕内容是占位）就算「用户负责」，不再自动补。
    if (srcs[key] === 'user') continue
    if (!isMeaningful(prefs[key])) missing.push(key)
  }
  return missing
}

/**
 * 设定兜底补全（用户已选「两者结合」策略）。
 *
 * 走完 applyGeneratedWorldview + applyGeneratedPreferences 之后如果还有空缺，
 * 说明大纲模型偷懒了（提示词已硬性要求必填）。此时**额外跑一次专门的补全调用**，
 * 把这些字段补齐 —— 只补空缺、不覆盖用户手填，也不重规划剧情。
 *
 * 失败不阻断创书：抛错由调用方吞掉，作品照常以「设定可能不全」的状态可用。
 */
export async function fillMissingSettings(project) {
  const missing = missingSettingFields(project)
  if (!missing.length) return { filled: [], skipped: true }

  const cfg = store.getConfig()
  const { text, usage } = await chat({
    ...cfg,
    messages: settingsFillMessages({
      idea: project.idea,
      genre: project.genre,
      genreTags: project.genreTags,
      targetChapters: project.targetChapters,
      preferences: project.preferences,
      title: project.title || project.outline?.title || '',
      givenWorld: String(project.authorWorldRules || '').trim(),
    }),
    temperature: 0.8,
    ...outlineThinkingParams(cfg),
    jsonMode: true,
    timeoutMs: 180000,
  })
  accUsage(project, usage)

  const parsed = parseJSON(text) || {}
  // 与大纲同一条合并规则：用户手填的不动，只补空缺。
  applyGeneratedWorldview(project, parsed)
  applyGeneratedPreferences(project, { style: parsed.style, preferences: parsed.preferences })
  return { filled: missing.filter((k) => !missingSettingFields(project).includes(k)), skipped: false }
}

export async function generateOutline(project) {
  const cfg = store.getConfig()
  const { text, usage } = await chat({
    ...cfg,
    messages: outlineMessages(project),
    temperature: 0.9,
    ...outlineThinkingParams(cfg),
    jsonMode: true,
    timeoutMs: 300000,
  })
  accUsage(project, usage)

  const parsed = normalizeOutline(parseJSON(text), project.targetChapters)
  project.outline = parsed.outline
  project.status = 'ready'
  project.outlineError = null
  project.outlineAttemptedAt = new Date().toISOString()
  // 用户手填的文风优先（兼容旧键 style 与合并键 styleSpec）；
  // 未填时 applyGeneratedPreferences 会回填模型生成的 style。
  const userStyle = String(project.preferences?.styleSpec || project.preferences?.style || '').trim()
  if (userStyle) project.outline.style = userStyle
  // 世界观 + 作者偏好：用户手填的是作者意图，绝不被模型输出覆盖；
  // 未填时用大纲模型生成的内容自动补齐，用户不必再从零手敲。
  // 这两个字段只进入重排（replan）与作者侧展示，不直接进 WriterPacket，公开性由下游投影把关。
  applyGeneratedWorldview(project, parsed.outline)
  applyGeneratedPreferences(project, parsed.outline)
  mergeEntities(project, parsed.entities)
  ensureLedger(project)
  normalizeForeshadows(project)
  // 概要审查结果落成**可见的诊断**（照着 collectContextNotes 的既有范式：
  // 不阻断，但必须留痕迹）。放在 mergeEntities 之后 —— 诊断文案要用角色名。
  project.outlineNotes = outlineAuditNotes(parsed.outline.summaryAudit, project)
  if (project.outlineNotes.length) console.warn(`[outline] ${project.outlineNotes.join('；')}`)
  if (!project.title) project.title = parsed.outline.title || '未命名'
  return project
}

/* 正文生成**只有一条路径**：`workflow.createRun()`（持久化任务 + 提交门禁 + 审批 + 幂等）。
   这里原来还有一条同步出口 `generateChapter()`，它**一个活调用者都没有**，却在暗处维护着第二套
   packet 组装、模型调用、清洗与落账逻辑（`cleanBody` 就只挂在它身上，害得活路径反而没清正文）。
   2026-10-14 整段删除（连同一个只被它用到的 `countWords`）。要生成正文请走 HTTP API / workflow。 */

/* ------------------------------- 导出 ------------------------------- */

/**
 * 可导出的内容分区。
 * key 必须与前端 src/components/ExportSheet.jsx 中的 SECTIONS 保持一致。
 * isDefault 为 true 的项在界面里默认勾选（即「书名 + 正文」）。
 */
export const EXPORT_SECTIONS = [
  { key: 'title', label: '书名', hint: '作品标题', isDefault: true },
  { key: 'synopsis', label: '简介与主题', hint: '一句话梗概、题材、主题、文风', isDefault: false },
  { key: 'outline', label: '大纲', hint: '三幕结构、分卷目标、分章梗概', isDefault: false },
  { key: 'characters', label: '人物设定', hint: '角色身份、动机与隐秘', isDefault: false },
  { key: 'foreshadows', label: '伏笔清单', hint: '已埋线索与回收计划', isDefault: false },
  { key: 'body', label: '正文', hint: '已完成的章节全文', isDefault: true },
  { key: 'stats', label: '统计信息', hint: '章节数与字数', isDefault: false },
]

/**
 * 支持的导出格式。
 *
 * ⚠️ `label` / `note` 也放在这里（而不是只放在前端）：`EXPORT_SECTIONS` 早就是这么做的，
 *    而且两者都由 `/api/export-options` 下发。⛔ 前端**不许**再抄一份格式清单 ——
 *    它原来抄了，结果 `/api/export-options` 返回的 `formats` 整个没人读（典型的「信息≠约束」）。
 */
export const EXPORT_FORMATS = {
  md: { ext: 'md', mime: 'text/markdown', label: 'Markdown', note: '保留标题层级，便于再排版' },
  txt: { ext: 'txt', mime: 'text/plain', label: '纯文本', note: '纯文字，随处分发' },
}

/**
 * 归一化导出参数：
 *   格式只认 md / txt（默认 md）；
 *   分区只保留认识的 key，并按 EXPORT_SECTIONS 的顺序去重排列；
 *   传入空分区时退回默认项（书名 + 正文）。
 */
export function normalizeExportOptions(input = {}) {
  const format = EXPORT_FORMATS[input.format] ? input.format : 'md'
  const known = EXPORT_SECTIONS.map((s) => s.key)
  const order = new Map(known.map((k, i) => [k, i]))

  let raw = input.parts
  if (typeof raw === 'string') raw = raw.split(',')
  let parts = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter((x) => order.has(x)) : []
  parts = [...new Set(parts)].sort((a, b) => order.get(a) - order.get(b))
  if (!parts.length) parts = EXPORT_SECTIONS.filter((s) => s.isDefault).map((s) => s.key)
  return { format, parts }
}

/** 中文按 2 列宽计算的显示宽度，用于纯文本格式的下划线长度 */
function displayWidth(text) {
  let w = 0
  for (const ch of String(text)) {
    w += /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
  }
  return w
}

/** 纯文本标题下的下划线 */
function underline(text, ch) {
  return ch.repeat(Math.min(28, Math.max(8, displayWidth(text))))
}

/** 角色卡：优先取实体表（含隐秘），退回大纲 cast */
function characterCards(project) {
  const ents = (project.entities || []).filter((e) => e.kind === 'character')
  if (ents.length) {
    return ents.map((e) => {
      const identity = e.publicIdentity || e.secret || ''
      return {
        name: e.name,
        role: e.publicRole || e.authorRole || '',
        identity,
        want: e.want || '',
        fear: e.fear || '',
        secret: e.secret && e.secret !== identity ? e.secret : '',
      }
    })
  }
  return (project.outline?.cast || []).map((c) => ({
    name: c.name,
    role: c.role || '',
    identity: c.identity || '',
    want: c.want || '',
    fear: c.fear || '',
    secret: '',
  }))
}

/**
 * 把作品按选中的分区编译成一串「节点」。
 * 节点是格式无关的中间表示，再由 renderDocument 渲染成 md 或 txt。
 */
function buildExportNodes(project, parts) {
  const o = project.outline || {}
  const chapters = (project.chapters || [])
    .filter((c) => c.status === 'committed')
    .sort((a, b) => a.no - b.no)
  const has = (k) => parts.includes(k)
  const N = []

  if (has('title')) N.push({ t: 'h1', text: project.title || project.id })

  if (has('synopsis')) {
    N.push({ t: 'h2', text: '简介' })
    if (o.logline || project.idea) N.push({ t: 'quote', text: o.logline || project.idea })
    N.push({ t: 'bullet', text: `题材：${project.genre || '—'}` })
    N.push({ t: 'bullet', text: `主题：${o.theme || '—'}` })
    if (o.style) N.push({ t: 'bullet', text: `文风：${o.style}` })
  }

  if (has('outline')) {
    N.push({ t: 'h2', text: '大纲' })
    if (o.acts?.length) {
      N.push({ t: 'h3', text: '三幕结构' })
      for (const a of o.acts) {
        N.push({ t: 'bold', text: a.name })
        if (a.summary) N.push({ t: 'para', text: a.summary })
        if (a.function) N.push({ t: 'para', text: `叙事功能：${a.function}` })
      }
    }
    for (const v of o.volumes || []) {
      N.push({ t: 'h3', text: v.title })
      if (v.goal) N.push({ t: 'para', text: `本卷目标：${v.goal}` })
      for (const c of v.chapters || []) {
        N.push({ t: 'bullet', text: `第 ${c.no} 章　${c.title}` })
        if (c.summary) N.push({ t: 'indent', text: c.summary })
      }
    }
  }

  if (has('characters')) {
    const cards = characterCards(project)
    if (cards.length) {
      N.push({ t: 'h2', text: '人物设定' })
      for (const p of cards) {
        N.push({ t: 'h3', text: p.name + (p.role ? `　${p.role}` : '') })
        if (p.identity) N.push({ t: 'para', text: `身份：${p.identity}` })
        if (p.want) N.push({ t: 'para', text: `想要：${p.want}` })
        if (p.fear) N.push({ t: 'para', text: `恐惧：${p.fear}` })
        if (p.secret) N.push({ t: 'para', text: `隐秘（作者可见）：${p.secret}` })
      }
    }
  }

  if (has('foreshadows') && o.foreshadows?.length) {
    N.push({ t: 'h2', text: '伏笔清单' })
    o.foreshadows.forEach((f, i) => {
      N.push({ t: 'para', text: `${i + 1}. ${f.seed || ''}` })
      if (f.payoff) N.push({ t: 'indent', text: `回收：${f.payoff}` })
    })
  }

  if (has('body') && chapters.length) {
    N.push({ t: 'rule' })
    N.push({ t: 'h2', text: '正文' })
    for (const ch of chapters) {
      if (ch.volumeTitle) N.push({ t: 'h3', text: ch.volumeTitle })
      N.push({ t: 'h4', text: `第 ${ch.no} 章　${ch.title}` })
      for (const p of String(ch.text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
        N.push({ t: 'para', text: p, novel: true })
      }
    }
  }

  if (has('stats')) {
    const words = chapters.reduce((a, c) => a + (c.wordCount || 0), 0)
    N.push({ t: 'h2', text: '统计信息' })
    N.push({ t: 'bullet', text: `已写章节：${chapters.length} / ${o.totalChapters || '—'}` })
    N.push({ t: 'bullet', text: `正文字数：${words}` })
    N.push({ t: 'bullet', text: `导出日期：${new Date().toISOString().slice(0, 10)}` })
  }

  return N
}

/** 节点 → 文本。md 与 txt 两套渲染；块间空行统一在这里控制。 */
function renderDocument(nodes, format) {
  const md = format === 'md'
  const out = []
  let prevWasItem = false
  for (const n of nodes) {
    const isItem = n.t === 'bullet' || n.t === 'indent'
    // 连续条目之间不插空行，其余块之间空一行
    if (out.length && !(isItem && prevWasItem)) out.push('')
    switch (n.t) {
      case 'h1':
        out.push(md ? `# ${n.text}` : n.text)
        if (!md) out.push(underline(n.text, '='))
        break
      case 'h2':
        out.push(md ? `## ${n.text}` : n.text)
        if (!md) out.push(underline(n.text, '-'))
        break
      case 'h3':
        out.push(md ? `### ${n.text}` : n.text)
        break
      case 'h4':
        out.push(md ? `#### ${n.text}` : `【${n.text}】`)
        break
      case 'rule':
        out.push(md ? '---' : '-'.repeat(30))
        break
      case 'bold':
        out.push(md ? `**${n.text}**` : n.text)
        break
      case 'quote':
        out.push(md ? `> ${n.text}` : n.text)
        break
      case 'bullet':
        out.push(md ? `- ${n.text}` : `· ${n.text}`)
        break
      case 'indent':
        out.push(md ? n.text : `　　${n.text}`)
        break
      default:
        // 正文段落：纯文本缩进两格，更接近成书阅读
        out.push(!md && n.novel ? `　　${n.text}` : n.text)
    }
    prevWasItem = isItem
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/**
 * 生成导出文档。
 * @returns {{ body: string, ext: string, mime: string, filename: string }}
 */
export function exportDocument(project, options = {}) {
  const opts = normalizeExportOptions(options)
  const nodes = buildExportNodes(project, opts.parts)
  const fmt = EXPORT_FORMATS[opts.format]
  const body = renderDocument(nodes, opts.format)
  const safeTitle = String(project.title || project.id || '未命名').replace(/[\\/:*?"<>|]/g, '_')
  return { body, ext: fmt.ext, mime: fmt.mime, filename: `${safeTitle}.${fmt.ext}` }
}

/** 兼容旧调用：默认 Markdown、书名 + 正文 */
export function exportMarkdown(project) {
  return exportDocument(project, { format: 'md', parts: ['title', 'body'] }).body
}
