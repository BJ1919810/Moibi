/**
 * 正式作者修改事务：持久化草稿 -> 影响分析 -> 作者确认 -> CAS 提交 -> 写入审计。
 * 项目 editRevision 与章节 headVersion 两条版本线均要一致，任何旧请求都不能覆盖新进度。
 * change 文件只是待办/收据，不是权威状态；权威状态始终是项目快照。
 */
import crypto from 'node:crypto'
import * as store from './store.js'
import { analyzeChange } from './change-impact.js'
import { updateAuthorSettings, PREF_BUDGET } from './author-control.js'
import { validateChapterCount } from './creative-options.js'
import { findChapterMeta, liveChapter } from './projection.js'
import { stripChapterTitlePrefix, foreshadowId } from './schema.js'

const trim = (value, limit=1200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`修改内容不能为空，且不得超过 ${limit} 字`)
  return value.trim()
}
const safeIndex = (n, max) => { if (!Number.isInteger(n) || n < 0 || n >= max) throw new Error('索引不存在'); return n }
const committed = (p,no) => (p.chapters || []).some(c => c.no === no && c.status === 'committed')

/* --------------------------------------------------------------------------
 * 「这次改动到底改了什么」——由**程序**对比前后快照算出，不采信模型自述。
 *
 * 背景（主人反馈）：助手面板显示的 `summary` 是**模型自己写的说明**（只被截断过），
 * 所以「改了哪、改了什么」常年模糊。可靠的答案只能来自前后对比。
 *
 * ⚠️ 判据按 **change 的形状**推导（entityId / foreshadowId / field / values / chapterNo），
 *    **不按 kind 枚举** —— 助手那条链路用的是自己一套 kind 名（`chapter_count` 等），
 *    按 kind 写会漏掉一半入口，而且每加一个 kind 都要回来补一次（这个项目吃过太多次这种亏）。
 * ------------------------------------------------------------------------ */
const PREF_LABEL = { styleSpec:'文风设定', style:'文风', tone:'基调', pace:'节奏', protagonist:'主角设定',
  ending:'结局偏好', forbidden:'禁止描写', coreGoal:'核心目标' }
const CHAR_LABEL = { personality:'性格', appearance:'外貌', motivation:'动机', arc:'人物弧线',
  publicIdentity:'公开身份', secret:'作者侧秘密', relationships:'关系补充' }
const FS_LABEL = { seed:'线索铺设', payoff:'作者侧回收真相', safeReveal:'回收披露授权' }

export function describeChange(before, after, change) {
  const out = []
  /**
   * ⚠️ 「要不要折叠成长度」必须**按实际文本长度**判断，不能按字段判断 ——
   *    我第一版把「角色卡字段」一律折叠，结果两个字改成另两个字会显示「2 字 → 2 字」，
   *    恰恰是主人要看的「改了什么」。折叠只对真正的长文本（>40 字）生效。
   */
  const COLLAPSE_OVER = 40
  const add = (label, field, b, a) => {
    const norm = (v) => (v == null ? '' : String(v))
    const bb = norm(b), aa = norm(a)
    if (bb === aa) return
    if (bb.length > COLLAPSE_OVER || aa.length > COLLAPSE_OVER) {
      out.push({ label, field, before: bb ? `${bb.length} 字` : '（原为空）', after: aa ? `${aa.length} 字` : '（已清空）' })
      return
    }
    out.push({ label, field, before: bb, after: aa })
  }
  const c = change || {}
  
  // ① 伏笔系（形状上带 foreshadowId；新增时是服务端刚派生出来的 id）
  if (c.foreshadowId || c.kind === 'foreshadow_add') {
    const b = (before.outline?.foreshadows || []).find((f) => f.id === c.foreshadowId)
    const a = (after.outline?.foreshadows || []).find((f) => f.id === c.foreshadowId)
    if (c.kind === 'foreshadow_add') { add(`新增伏笔（${c.foreshadowId}）`, 'seed', '', a?.seed) ; add('回收真相', 'payoff', '', a?.payoff) }
    else if (c.kind === 'foreshadow_remove') add(`删除伏笔（${c.foreshadowId}）`, 'removed', b?.seed || '（有）', '（已删除）')
    else if (c.kind === 'foreshadow_link') {
      add(`伏笔 ${c.foreshadowId} · 埋设章`, 'plantChapter', b?.plantChapter, a?.plantChapter)
      add(`伏笔 ${c.foreshadowId} · 回收章`, 'payoffChapter', b?.payoffChapter, a?.payoffChapter)
      add(`伏笔 ${c.foreshadowId} · 关联状态`, 'linkStatus', b?.linkStatus, a?.linkStatus)
    } else if (c.field === 'safeReveal') {
      add(`伏笔 ${c.foreshadowId} · 回收披露授权`, 'safeReveal',
        b?.safeReveal?.text ? `已授权：${b.safeReveal.text}` : '未授权',
        a?.safeReveal?.text ? `已授权：${a.safeReveal.text}` : '未授权')
    } else add(`伏笔 ${c.foreshadowId} · ${FS_LABEL[c.field] || c.field}`, c.field, b?.[c.field], a?.[c.field])
  }
  // ② 角色秘密披露（带 entityId 且带 chapterNo）
  else if (c.kind === 'entity_reveal_projection') {
    const b = (before.entities || []).find((e) => e.id === c.entityId)
    const a = (after.entities || []).find((e) => e.id === c.entityId)
    const rec = (e) => (e?.revealProjections || []).slice(-1)[0]
    if (!rec(b)) add(`角色「${b?.name}」新增披露授权（第 ${c.chapterNo} 章起）`, 'reveal', '（未授权）', rec(a)?.safeText || '')
    else add(`角色「${b?.name}」的披露授权`, 'reveal', rec(b)?.safeText, rec(a)?.safeText)
  }
  // ③ 角色系
  else if (c.entityId) {
    const b = (before.entities || []).find((e) => e.id === c.entityId)
    const a = (after.entities || []).find((e) => e.id === c.entityId)
    const who = b?.name || ''
    if (c.kind === 'rename') add(`角色名「${who}」`, 'name', b?.name, a?.name)
    else if (c.field === 'relationships') add(`「${who}」的关系补充`, 'relationships',
      JSON.stringify(b?.characterCard?.relationships || []), JSON.stringify(a?.characterCard?.relationships || []))
    else if (c.field === 'publicIdentity' || c.field === 'secret') add(`「${who}」的${CHAR_LABEL[c.field] || c.field}`, c.field, b?.[c.field], a?.[c.field])
    else add(`「${who}」的${CHAR_LABEL[c.field] || c.field}`, c.field, b?.characterCard?.[c.field], a?.characterCard?.[c.field])
  }
  // ④ 偏好系（单个 field 或 values 批量）
  else if (c.values && typeof c.values === 'object') {
    for (const k of Object.keys(c.values)) add(PREF_LABEL[k] || k, k, before.preferences?.[k], after.preferences?.[k])
  } else if (c.field && c.kind === 'preferences') {
    // ⚠️ 必须限定 `kind === 'preferences'`：`reader_intro` 也带 `field`（logline/theme），
    //    不限定的话会被这个分支抢走、去 preferences 里找同名字段 ⇒ diff 恒为空（踩过）。
    add(PREF_LABEL[c.field] || c.field, c.field, before.preferences?.[c.field], after.preferences?.[c.field])
  }
  // ⑤ 章节/作品级
  else if (c.chapterNo != null) {
    const metaOf = (p) => (p.outline?.volumes || []).flatMap((v) => v.chapters || []).find((x) => x.no === c.chapterNo)
    const b = metaOf(before), a = metaOf(after)
    if (c.kind === 'chapter_task_approval') add(`第 ${c.chapterNo} 章 · 写作任务批准`, 'writerTaskApproval', b?.writerTaskApproval || 'proposed', a?.writerTaskApproval)
    else if (c.kind === 'chapter_task_text') {
      add(`第 ${c.chapterNo} 章 · 写作任务（表层）`, 'writerSummary', b?.writerSummary, a?.writerSummary)
      add(`第 ${c.chapterNo} 章 · 本章目标（表层）`, 'writerGoal', b?.writerGoal, a?.writerGoal)
    }
    else if (c.kind === 'chapter_title') add(`第 ${c.chapterNo} 章标题`, 'title', b?.title, a?.title)
    else add(`第 ${c.chapterNo} 章的章节意图`, 'authorInstruction', b?.authorInstruction, a?.authorInstruction)
  } else {
    if (c.kind === 'target_chapters') add('章节目标', 'targetChapters', before.targetChapters, after.targetChapters)
    else if (c.kind === 'book_title') add('书名', 'title', before.title, after.title)
    else if (c.kind === 'reader_intro') {
      if (c.field === 'theme') add('读者可见主题', 'readerTheme', before.outline?.readerTheme, after.outline?.readerTheme)
      else add('读者简介', 'readerLogline', before.outline?.readerLogline, after.outline?.readerLogline)
    }
    else if (c.kind === 'theme') add('主题', 'theme', before.outline?.theme, after.outline?.theme)
    else if (c.kind === 'world') add('世界观', 'authorWorldRules', before.authorWorldRules, after.authorWorldRules)
    else if (c.kind === 'plot_direction') add('剧情方向', 'authorPlotDirection', before.authorPlotDirection, after.authorPlotDirection)
    else if (c.kind === 'act') add(`第 ${(c.actIndex ?? 0) + 1} 幕小结`, 'act', before.outline?.acts?.[c.actIndex]?.summary, after.outline?.acts?.[c.actIndex]?.summary)
  }
  return out
}

/**
 * 在**副本**上试算一次修改，只为拿到「改前/改后」——不落盘、不改任何状态。
 * 助手面板用它把「将要改什么」摆给用户看（而不是让模型自述）。
 */
export function previewChangeDiff(project, change) {
  const applied = applyChange(structuredClone(project), change, 'preview')
  return describeChange(project, applied, change)
}

/**
 * 把「关系补充」的可读文本解析回结构化数组。
 *
 * 角色卡里的 relationships 是 [{name,relation,note}]，而编辑界面是 textarea，
 * 直接赋值会得到字符串（旧 bug：显示成 [object Object]，还会把数组写成字符串）。
 * 约定格式「名字 | 关系 | 备注」，每行一条；用全角竖线也接受。
 * 无法解析出名字的行直接丢弃，避免把无效内容写进角色卡。
 */
export function parseRelations(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.split(/[|｜]/).map((s) => s.trim()))
    .filter((parts) => parts[0])
    .map((parts) => ({ name: parts[0] || '', relation: parts[1] || '', note: parts[2] || '' }))
}

/** 服务端白名单：从不接受客户端提交整份实体/outline/ledger。 */
export function validateChange(p, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('修改内容格式无效')
  const kind = String(raw.kind || '')
  const c = {kind}
  if (kind === 'rename' || kind === 'character_field') {
    const entity = (p.entities || []).find(e=>e.id===raw.entityId)
    if (!entity) throw new Error('角色 ID 不存在')
    c.entityId=entity.id
    if (kind==='rename') {
      c.value=trim(raw.value,32)
      if ((p.entities || []).some(e=>e.id!==entity.id && [e.name,...(e.aliases||[])].includes(c.value))) throw new Error('角色名与其他角色重名')
    } else {
      if (!['personality','appearance','motivation','arc','publicIdentity','secret','relationships'].includes(raw.field)) throw new Error('角色字段不允许编辑')
      c.field=raw.field; c.value=trim(raw.value,1200)
    }
  } else if (kind==='theme') {
    // theme 会写进 outline.theme ⇒ 必须已有大纲。
    c.value=trim(raw.value,2400)
    if (!p.outline) throw new Error('没有作品大纲')
  } else if (kind==='world' || kind==='plot_direction') {
    // 这两个都落在**作者侧独立字段**（authorWorldRules / authorPlotDirection），
    // 不写 outline ⇒ 不要求大纲存在。
    // 尤其 plot_direction 是用户的主观意图入口，大纲生成失败时恰恰最需要能写，
    // 用来指导随后的重新生成 / 重排，不该被「没有大纲」挡在外面。
    c.value=trim(raw.value,2400)
  } else if (kind==='act') {
    c.actIndex=safeIndex(raw.actIndex,p.outline?.acts?.length || 0)
    c.value=trim(raw.value,1600)
  } else if (kind==='foreshadow') {
    c.foreshadowId=String(raw.foreshadowId || '')
    const foreshadow=(p.outline?.foreshadows || []).find(f=>f.id===c.foreshadowId)
    if (!foreshadow) throw new Error('伏笔 ID 不存在')
    if (!['seed','payoff','safeReveal'].includes(raw.field)) throw new Error('伏笔字段不允许编辑')
    c.field=raw.field
    if (raw.field==='safeReveal') {
      /**
       * 回收披露授权 —— 全项目**唯一**写 `foreshadow.safeReveal` 的入口。
       *
       * 背景：`projection.projectForeshadows()` 要求 `safeReveal.approved===true` 且有文本
       * 才放行 `pay_off`，而此前**只有读路径、没有任何写入路径** ⇒ 带伏笔的作品写到回收章
       * 永久卡在 `not-approved`（两轮压测的第 26–30 章与第 18 章现场，¥0，死在模型调用前）。
       *
       * 约定：填文本 = 授权（写下「可以对读者说出的版本」）；空串 = 撤回授权。
       * 原始 `payoff`（作者侧真相）永远不进正文，只有这里的 `safeReveal.text` 会。
       * `approved` / `reviewedBy` / `reviewedAt` 一律由服务端写入，不接受客户端提交。
       */
      const text = typeof raw.value==='string' ? raw.value.trim() : ''
      if (text.length>1200) throw new Error('回收披露文本不得超过 1200 字')
      if (text) {
        // 关联还没审核时连回收章都不确定，先做关联审核再谈回收授权。
        if (foreshadow.linkStatus==='needsReview') throw new Error('该伏笔的关联仍待审核，请先确认埋设/回收章')
        const payoffChapter=Number(foreshadow.payoffChapter ?? foreshadow.revealAt)
        if (!Number.isInteger(payoffChapter) || payoffChapter<1) throw new Error('该伏笔还没有确定的回收章，无法授权')
      }
      c.value=text
    } else {
      c.value=trim(raw.value,1200)
    }
  } else if (kind==='foreshadow_link') {
    /**
     * 关联审核：由作者确认这条伏笔「在哪一章埋、在哪一章收」。
     * 存在意义：迁移来的旧作品伏笔是 `linkStatus:'needsReview'` + 章号为空，
     * 而回收门禁（`revealDecision`）会判 `unreviewed-link` / `wrong-chapter`
     * ⇒ 一旦模型在某一章排了 pay_off，那一章**永久写不出来**，而提示的出路
     * （「请先确认埋设/回收章」）在界面上**根本不存在**（2026-10-13 审计 P0）。
     */
    c.foreshadowId=String(raw.foreshadowId || '')
    if (!(p.outline?.foreshadows || []).some(f=>f.id===c.foreshadowId)) throw new Error('伏笔 ID 不存在')
    const num = (v) => (v == null || v === '' ? null : Number(v))
    const plant=num(raw.plantChapter), payoff=num(raw.payoffChapter)
    for (const [label,no] of [['埋设章',plant],['回收章',payoff]]) {
      if (no == null) continue
      if (!Number.isInteger(no) || !findChapterMeta(p.outline, no)) throw new Error(`${label}必须是作品规划内的章号（第 1～${p.outline?.totalChapters || '?'} 章）`)
    }
    if (plant == null && payoff == null) throw new Error('埋设章与回收章至少要填一个')
    if (plant != null && payoff != null && plant > payoff) throw new Error('埋设章不能晚于回收章')
    c.plantChapter=plant; c.payoffChapter=payoff
  } else if (kind==='chapter_task_approval') {
    /**
     * 批准本章的写作任务（`writerSummary/writerGoal`）。
     * 存在意义：这两个字段是**作者付过钱的**规划产物，但投影层要求
     * `writerTaskApproval==='author-approved'` 才把它们交给正文模型；
     * 全项目**没有任何写入方**（审计 P0）⇒ 每章都白付一次 L2 调用去现编安全任务，
     * 而这笔规划费从来没有真正用在正文上。
     */
    c.chapterNo=Number(raw.chapterNo)
    const meta=findChapterMeta(p.outline, c.chapterNo)
    if (!meta) throw new Error('章节不存在')
    if (committed(p,c.chapterNo)) throw new Error('正式章节的任务不需要再批准')
    if (!String(meta.writerSummary || '').trim() && !String(meta.writerGoal || '').trim()) throw new Error('本章还没有可批准的任务描述，请先细化章节')
  } else if (kind==='entity_reveal_projection') {
    /**
     * 角色秘密的**可控披露**：作者指定「哪个秘密、以什么措辞、从第几章起可以告诉读者」。
     * 存在意义：`projection.projectEntityReveals()` 读 `entity.revealProjections[].safeText`
     * 与章节 `reveals[]` 才放行角色真相，而**全项目没有任何写入方**（审计 P0）⇒
     * 作者能写 `secret`，却永远无法授权披露；「【读者此前已知】」永远是空的。
     *
     * ⚠️ 必须**一次写两处**：角色级（批准了什么）+ 章级（什么时候揭示）。
     *    只批角色级 ⇒ 正文永远拿不到（那正是这个坑本身）；只写章级 ⇒ 没有可披露的文本。
     */
    const entity=(p.entities || []).find(e=>e.id===String(raw.entityId || ''))
    if (!entity) throw new Error('角色 ID 不存在')
    c.entityId=entity.id
    c.value=trim(raw.value,1200)   // 就是 safeText：可以对读者说出的版本
    c.chapterNo=Number(raw.chapterNo)
    const meta=findChapterMeta(p.outline, c.chapterNo)
    if (!meta) throw new Error('披露章不存在（必须在本作规划范围内）')
    if (committed(p,c.chapterNo)) throw new Error('不能在已定稿的章节上新增披露')
    if (!(meta.cast || []).map(String).includes(entity.id)) throw new Error(`第 ${c.chapterNo} 章的计划里没有「${entity.name}」出场，先把它加进本章 cast`)
  } else if (kind==='foreshadow_add') {
    /**
     * 新增一条伏笔（主人反馈：伏笔只能改不能增删）。
     * id 由 `seed` 派生（与开书路径同一套 `foreshadowId`）⇒ 同一句线索重复提交天然去重、稳定。
     * 章号先留空：作者随后用「伏笔关联章号」确认埋/收章，或由下一次重排安排。
     */
    if (!p.outline) throw new Error('没有作品大纲')
    c.seed=trim(raw.seed,240)
    c.payoff=trim(raw.payoff,600)
    c.foreshadowId=foreshadowId(c.seed)
    if ((p.outline.foreshadows || []).some(f=>f.id===c.foreshadowId)) throw new Error('已经有一条一模一样的线索铺设了，不必重复新增')
  } else if (kind==='foreshadow_remove') {
    c.foreshadowId=String(raw.foreshadowId || '')
    const f=(p.outline?.foreshadows || []).find(x=>x.id===c.foreshadowId)
    if (!f) throw new Error('伏笔 ID 不存在')
    // ⛔ 已经真实铺设/回收过的伏笔**不许删**：账本是 append-only 的「已发生事实」，
    //    删掉声明会让事件与线索指向一个不存在的伏笔（等于篡改历史）。
    //    不想再用它的话，改写它的回收真相、或把回收授权撤掉即可。
    const appeared=(p.ledger?.foreshadowEvents || []).some(e=>e.foreshadowId===f.id && e.status==='accepted')
    if (appeared) throw new Error('这条伏笔已经在正文里真实出现过，不能删除（账本会指向不存在的东西）；如果不想再用它，可以改写它的回收真相或撤回授权')
  } else if (kind==='chapter_task_text') {
    /**
     * 编辑本章的**写作任务**（`writerSummary/writerGoal`）—— 这是「概要审查」那条诊断的**真实出口**。
     *
     * 为什么必须有它：概要审查会说「这一章的表层概要可能抄了回收真相的措辞」，
     * 而在它之前**界面上根本改不了这两个字段**，建议只能指向「去伏笔页改 payoff」——
     * 但那修不掉已经写进概要的那句话（审计记为「护栏指向的出口不存在/不对」）。
     */
    c.chapterNo=Number(raw.chapterNo)
    if (!findChapterMeta(p.outline, c.chapterNo)) throw new Error('章节不存在')
    if (committed(p,c.chapterNo)) throw new Error('正式章节的写作任务不能再改（它已经写进正文了）')
    const soft=(v,limit)=>{ const s=String(v??'').trim(); if (s.length>limit) throw new Error(`写作任务不得超过 ${limit} 字`); return s }
    c.writerSummary=soft(raw.writerSummary,200)
    c.writerGoal=soft(raw.writerGoal,120)
    if (!c.writerSummary && !c.writerGoal) throw new Error('写作任务不能两项都为空')
  } else if (kind==='chapter_intent') {
    c.chapterNo=Number(raw.chapterNo)
    if (!Number.isInteger(c.chapterNo) || !findChapterMeta(p.outline,c.chapterNo)) throw new Error('章节不存在')
    if (committed(p,c.chapterNo)) throw new Error('正式章节不能修改章节意图')
    c.value=trim(raw.value,500)
  } else if (kind==='book_title') {
    c.value=trim(raw.value,30)
  } else if (kind==='reader_intro') {
    /**
     * 公开简介 / 公开主题。
     *
     * ⛔ 这里原来把 `publicLoglineApproved` **无条件置 false**，而全项目**没有任何地方置 true**
     *    ⇒ 提示词里的【作品】永远是中性占位「沿当前人物处境与已公开冲突展开故事」、
     *      【主题】永远是「—」：**公开简介与主题从未进过正文模型**（今天抓到的 form ①）。
     * 修法：**作者亲手提交的就是批准**（与 `chapter_task_text` 同一口径）。
     *    允许提交空值 = 撤回公开（退回中性占位，仍然不会把作者侧真相透传）。
     *    AI 代笔那条路维持 approved=false（见 assistant.js），要作者确认后提交才算。
     */
    const soft=(v,limit)=>{ const s=String(v??'').trim(); if (s.length>limit) throw new Error(`不得超过 ${limit} 字`); return s }
    c.field = raw.field==='theme' ? 'theme' : 'logline'
    c.value = soft(raw.value, c.field==='theme' ? 120 : 200)
  } else if (kind==='chapter_title') {
    c.chapterNo=Number(raw.chapterNo)
    if (!Number.isInteger(c.chapterNo) || !findChapterMeta(p.outline,c.chapterNo) || committed(p,c.chapterNo)) throw new Error('目标章节不存在或已经定稿')
    c.value=trim(raw.value,80)
  } else if (kind==='preferences_bulk') {
    if (!raw.values || typeof raw.values!=='object' || Array.isArray(raw.values) || !Object.keys(raw.values).length) throw new Error('缺少偏好字段')
    c.values={}
    for (const [key,val] of Object.entries(raw.values)) {
      if (!['styleSpec','style','tone','pace','forbidden','coreGoal','protagonist','ending'].includes(key)) throw new Error('偏好字段不允许编辑')
      c.values[key]=trim(val,key==='styleSpec'?PREF_BUDGET:1200)
    }
  } else if (kind==='preferences') {
    if (!['styleSpec','style','tone','pace','forbidden','coreGoal','protagonist','ending'].includes(raw.field)) throw new Error('偏好字段不允许编辑')
    c.field=raw.field; c.value=trim(raw.value,raw.field==='styleSpec'?PREF_BUDGET:1200)
  } else if (kind==='target_chapters') {
    c.value=validateChapterCount(raw.value,Math.max(0,...(p.chapters || []).filter(ch=>ch.status==='committed').map(ch=>ch.no)))
  } else throw new Error('未知修改类型')
  return c
}

export function applyChange(project, change, requestId) {
  const c=validateChange(project,change)
  let next
  if (c.kind==='rename') next=updateAuthorSettings(project,{rename:{entityId:c.entityId,name:c.value}},project.editRevision||0)
  else if (c.kind==='preferences') next=updateAuthorSettings(project,{preferences:{[c.field]:c.value}},project.editRevision||0)
  else if (c.kind==='preferences_bulk') next=updateAuthorSettings(project,{preferences:c.values},project.editRevision||0)
  else if (c.kind==='target_chapters') next=updateAuthorSettings(project,{targetChapters:c.value},project.editRevision||0)
  else {
    next=structuredClone(project)
    if (c.kind==='character_field') {
      const e=next.entities.find(x=>x.id===c.entityId)
      if (c.field==='publicIdentity' || c.field==='secret') e[c.field]=c.value
      // 关系是结构化数组，不能把 textarea 的字符串直接写进角色卡。
      else if (c.field==='relationships') e.characterCard={...(e.characterCard||{}),relationships:parseRelations(c.value)}
      else e.characterCard={...(e.characterCard||{}),[c.field]:c.value}
      e.updatedAt=new Date().toISOString()
    }
    else if (c.kind==='book_title') {next.title=c.value;if(next.outline) next.outline.title=c.value}
    else if (c.kind==='reader_intro') {
      // 作者亲手提交 = 批准（空值 = 撤回公开，退回中性占位）
      const v=String(c.value||'').trim()
      if (c.field==='theme') { next.outline.readerTheme=c.value; next.outline.publicThemeApproved=!!v }
      else { next.outline.readerLogline=c.value; next.outline.publicLoglineApproved=!!v }
    }
    else if (c.kind==='chapter_title') next.outline.volumes.flatMap(v=>v.chapters||[]).find(ch=>ch.no===c.chapterNo).title=stripChapterTitlePrefix(c.value)
    else if (c.kind==='theme') next.outline.theme=c.value
    else if (c.kind==='world') next.authorWorldRules=c.value // 作者侧：不直接进入 WriterPacket
    else if (c.kind==='plot_direction') next.authorPlotDirection=c.value // 作者侧：重排模型可见
    else if (c.kind==='act') next.outline.acts[c.actIndex].summary=c.value
    else if (c.kind==='foreshadow') {
      const f=next.outline.foreshadows.find(x=>x.id===c.foreshadowId)
      if (c.field==='safeReveal') {
        // 见 validateChange 中的说明：这是唯一写 safeReveal 的地方。
        // 空文本 = 撤回授权（回到 not-approved）；伏笔声明与任何章计划一字不改。
        f.safeReveal = c.value
          ? { text:c.value, approved:true, reviewedBy:'owner', reviewedAt:new Date().toISOString() }
          : null
      } else {
        f[c.field]=c.value
        // 变更不授予任何提前揭示权，尤其不能把隐藏 payoff 推送给 WriterPacket。
        if (c.field==='payoff') { f.safeReveal=null }
      }
    }
    else if (c.kind==='foreshadow_link') {
      const f=next.outline.foreshadows.find(x=>x.id===c.foreshadowId)
      if (c.plantChapter != null) f.plantChapter=c.plantChapter
      if (c.payoffChapter != null) f.payoffChapter=c.payoffChapter
      // 作者确认过 ⇒ 不再是被隔离的「待审核候选」。
      // 注意：**不在这里补建章计划的 plant/pay_off 动作** —— 不伪造计划坐标；
      // 下一次细化/重排会按新的声明章排动作（归一化与自检都在 replan 侧）。
      f.linkStatus='explicit'
      f.linkProposal={...(f.linkProposal||{}), status:'reviewed', reviewer:'owner', reviewedAt:new Date().toISOString()}
    }
    else if (c.kind==='chapter_task_approval') {
      liveChapter(next, c.chapterNo).writerTaskApproval='author-approved'
    }
    else if (c.kind==='entity_reveal_projection') {
      const e=next.entities.find(x=>x.id===c.entityId)
      e.revealProjections ||= []
      // projectionId 由「角色 + 披露文本」派生：同一段文本重复提交是幂等覆盖，不会堆垃圾。
      const projectionId=`rp_${crypto.createHash('sha256').update(`${e.id}|${c.value}`).digest('hex').slice(0,10)}`
      const record={ id:projectionId, safeText:c.value, approved:true, reviewedBy:'owner',
        reviewedAt:new Date().toISOString(), prerequisiteEventIds:[] }
      const exist=e.revealProjections.find(x=>x.id===projectionId)
      if (exist) Object.assign(exist, record)
      else e.revealProjections.push(record)
      // 章级：本章就按这个安全版本披露（两处必须同事务落地，见 validateChange 的说明）
      // ⛔ 必须拿**活**的章节对象：`findChapterMeta()` 返回的是 `{...c}` 副本，
      //    在副本上 push 等于什么都没写（第一版就这么踩了，测试当场抓住：提交成功、reveals 仍是 undefined）
      const meta=liveChapter(next, c.chapterNo)
      meta.reveals ||= []
      if (!meta.reveals.some(r=>r.entityId===e.id && r.projectionId===projectionId)) {
        meta.reveals.push({ entityId:e.id, projectionId, approved:true,
          notBeforeChapter:c.chapterNo, prerequisiteEventIds:[] })
      }
    }
    else if (c.kind==='foreshadow_add') {
      next.outline.foreshadows ||= []
      next.outline.foreshadows.push({ id:c.foreshadowId, seed:c.seed, payoff:c.payoff,
        plantChapter:null, payoffChapter:null, revealAt:null, linkStatus:'explicit',
        lifecycle:'approved', prerequisiteEventIds:[] })
    }
    else if (c.kind==='foreshadow_remove') {
      next.outline.foreshadows=(next.outline.foreshadows || []).filter(x=>x.id!==c.foreshadowId)
      // 章节计划里的引用必须一并清掉，否则留下指向不存在伏笔的悬空引用
      for (const ch of (next.outline.volumes || []).flatMap(v=>v.chapters || [])) {
        if (Array.isArray(ch.foreshadows)) ch.foreshadows=ch.foreshadows.filter(a=>a.id!==c.foreshadowId)
      }
      // 线索账本里的外键置空 —— 线索本身是正文里真实发生过的，不能删
      for (const t of next.ledger?.plotThreads || []) if (t.foreshadowId===c.foreshadowId) t.foreshadowId=null
    }
    else if (c.kind==='chapter_task_text') {
      const meta=liveChapter(next,c.chapterNo)
      meta.writerSummary=c.writerSummary
      meta.writerGoal=c.writerGoal
      // 作者**亲手写**的就是批准（这道门禁防的是「模型自报 author-approved」，不是防作者）
      // ⇒ 直接落成 author-approved，一次提交即可，不必再点一次「批准」。
      meta.writerTaskApproval='author-approved'
    }
    else if (c.kind==='chapter_intent') next.outline.volumes.flatMap(v=>v.chapters || []).find(ch=>ch.no===c.chapterNo).authorInstruction=c.value
    next.editRevision=Number(next.editRevision||0)+1
    next.editHistory||=[]
    next.editHistory.push({revision:next.editRevision,at:new Date().toISOString(),fields:[c.kind]})
  }
  // 高风险自动冻结未来规划；下一次生成必须先重排，且已生成章节/账本不变。
  //
  // ⚠️ `pendingReplan` 的精确语义是「**有具体的未来章节计划需要重排**」——
  //    它会把后续所有正文生成**全部拦下**（workflow.createRun），
  //    直到跑完一次 `mode='full'` 的重排才解锁。所以只有在**真有东西要重排**时才该置位。
  //
  // 真实踩坑（压力测试挖出）：开书失败的空作品（0 卷）上改世界观/剧情方向，
  //    当时无条件 `pendingReplan=true`，但 `affectedChapters` 是 `[]`
  //    —— 没有任何未来章节计划存在。后果：
  //      ① 用户随后「重新生成大纲」**成功**，而那条路由**不清 `pendingReplan`**；
  //      ② 想写第 1 章 ⇒ 被拦「作品设定已变化，请先完成未写章节重排」；
  //      ③ 去点「重排」⇒ 试图重排一个从没细化过的大纲，失败；
  //      ⇒ 彻底卡死，且界面上没有任何出路。
  //
  // 判据用 `affectedChapters.length`（比「有没有大纲」更准）：
  //    · 无大纲 ⇒ 天然为 0（没有未来计划）
  //    · 有大纲但全部已定稿 ⇒ 也是 0（没有**未来**章节可重排）
  //    两种情况下改设定都只是「保存作者设定」，不该冻结作品。
  const impact=analyzeChange(project,c)
  const hasFutureToReplan = (impact.affectedChapters || []).length > 0
  const needsReplan = !!impact.replan && hasFutureToReplan
  if (needsReplan) next.pendingReplan=true
  next.editEvents||=[]
  next.editEvents.push({id:requestId,at:new Date().toISOString(),kind:c.kind,editRevision:next.editRevision,
    impact:{risk:impact.risk,affectedChapters:impact.affectedChapters,
      // 如实记录「本可重排但没有未来章节」的情形，便于事后追查为什么没冻结
      replanSkipped:!!impact.replan&&!hasFutureToReplan}})
  return next
}

export function createChangeService(repo=store) {
  function create(projectId, input={}) {
    const p=repo.getProject(projectId)
    if (!p) throw new Error('作品不存在')
    if (input.expectedHeadVersion != null && Number(input.expectedHeadVersion)!==Number(p.headVersion||0)) throw new Error('章节版本冲突，请刷新作品')
    if (input.expectedEditRevision != null && Number(input.expectedEditRevision)!==Number(p.editRevision||0)) throw new Error('编辑版本冲突，请刷新作品')
    const change=validateChange(p,input)
    const req={id:`cr_${crypto.randomBytes(12).toString('hex')}`,projectId:p.id, status:'pending',
      change,impact:analyzeChange(p,change),baseHeadVersion:Number(p.headVersion||0),
      baseEditRevision:Number(p.editRevision||0),createdAt:new Date().toISOString()}
    return repo.saveChange(req)
  }
  function get(id) {return repo.getChange(id)}
  function list(projectId) {return repo.listChanges(projectId)}
  function reject(id) {
    const req=repo.getChange(id);if (!req) throw new Error('修改请求不存在')
    if (req.status!=='pending') throw new Error('请求已处理，不能驳回')
    return repo.saveChange({...req,status:'rejected',rejectedAt:new Date().toISOString()})
  }
  function approve(id) {
    const req=repo.getChange(id);if (!req) throw new Error('修改请求不存在')
    const p=repo.getProject(req.projectId)
    if (!p) throw new Error('作品不存在')
    // 崩溃恢复：正式提交成功但请求收据未写完时，使用项目审计 ID 辨认已提交。
    const evidence=(p.editEvents||[]).find(e=>e.id===id)
    if (evidence) return {request:repo.saveChange({...req,status:'committed',committedAt:evidence.at,commitEditRevision:evidence.editRevision}),project:p}
    if (req.status!=='pending') throw new Error('请求已处理，不能重复确认')
    if (Number(p.headVersion||0)!==req.baseHeadVersion || Number(p.editRevision||0)!==req.baseEditRevision) {
      repo.saveChange({...req,status:'stale',staleAt:new Date().toISOString()})
      throw new Error('作品已变化，请刷新后重新提交修改')
    }
    const next=applyChange(p,req.change,req.id)
    if (Number(next.editRevision||0)!==req.baseEditRevision+1) throw new Error('没有产生有效修改，请勿重复提交相同内容')
    // 「改了什么」由程序算出来，随审计事件一起留档：界面上的红点与「查看上个版本」都读它
    const diff=describeChange(p,next,req.change)
    if (next.editEvents?.length) next.editEvents[next.editEvents.length-1].diff=diff
    repo.commitProjectEdit(next,req.baseHeadVersion,req.baseEditRevision)
    return {request:repo.saveChange({...req,status:'committed',committedAt:new Date().toISOString(),commitEditRevision:next.editRevision,diff}),project:next,diff}
  }
  return {create,get,list,reject,approve}
}
