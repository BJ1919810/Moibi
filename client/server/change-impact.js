/**
 * 作者修改影响分析。只读取作品中真实存在的引用，不把关键词识别当作依赖图。
 * high 表示未来章节计划需要作者确认后重排；已定稿正文永不自动改写。
 */
import { findChapterMeta } from './projection.js'

/**
 * 「这次**作者改动**的影响有多大」的三级词表。
 *
 * ⛔ 与 `chapter-planner.js` 的 `CHAPTER_RISK`（`normal|high`，判据是「**这一章**有没有秘密披露
 *    或要回收伏笔」）**不是一回事**：这里是 `low|medium|high`，判据是「会不会波及未来章节计划」。
 *    两边都用了字面量 `'high'`，历史上极易串味 ⇒ 现在各有名字，落盘字段也分开了
 *    （`impact.risk` vs `run.plan.chapterRisk`）。
 */
export const IMPACT_RISK = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' }

const committedNos = (p) => new Set((p.chapters || []).filter(c => c.status === 'committed').map(c => c.no))
const future = (p) => (p.outline?.volumes || []).flatMap(v => v.chapters || []).filter(c => !committedNos(p).has(c.no))

/**
 * 「这个作品还有没有**未来**章节要重排」——`pendingReplan` 的边界判据（唯一实现）。
 * 无大纲（开书失败）⇒ 天然为 0；全部章节已定稿 ⇒ 也是 0。两种情况都**不该冻结作品**
 * （冻结了就没有任何出路：正文被拦，重排又没有章节可排）。
 */
export function hasFutureChaptersToReplan(project) {
  return future(project).length > 0
}

export function analyzeChange(project, change) {
  const affected = new Set()
  const references = []
  const past = committedNos(project)
  const metas = (project.outline?.volumes || []).flatMap(v => v.chapters || [])
  let risk = 'low'
  let replan = false
  const tags = []
  const mark = (c, why) => { affected.add(c.no); references.push({ chapterNo:c.no, why, committed:past.has(c.no) }) }
  switch (change.kind) {
    case 'chapter_intent': {
      const meta = findChapterMeta(project.outline, change.chapterNo)
      if (meta) mark(meta,'章节指令')
      tags.push('chapter_intent')
      break
    }
    /**
     * 下面三个 kind 都是「作者批准某件已经存在的东西」，判据一致：
     * 改动的是**这一章将来能写什么**，不是章节计划本身 ⇒ 高风险、需要确认，但**不要求重排**。
     * （置 pendingReplan 会冻结整个作品并强制一次毫无必要的全局重排。）
     */
    case 'chapter_task_approval': case 'entity_reveal_projection': case 'chapter_task_text': {
      risk = 'high'; tags.push(change.kind)
      const meta = findChapterMeta(project.outline, change.chapterNo)
      const why = change.kind === 'chapter_task_approval' ? '批准本章写作任务'
        : change.kind === 'chapter_task_text' ? '编辑本章写作任务' : '角色秘密披露授权'
      if (meta) mark(meta, why)
      break
    }
    case 'foreshadow_link': {
      // 改了伏笔「在哪一章埋/收」⇒ 真的会影响未来章节的排期 ⇒ 需要重排
      // （是否真的置位仍由 `hasFutureChaptersToReplan` 决定，见 change-request.applyChange）
      risk = 'high'; replan = true; tags.push('foreshadow')
      for (const c of metas) if ((c.foreshadows || []).some(f => f.id === change.foreshadowId)) mark(c,'伏笔绑定')
      break
    }
    case 'rename':
    case 'character_field': {
      risk = change.kind === 'rename' || ['appearance','publicIdentity'].includes(change.field) ? 'medium' : 'high'
      replan = risk === IMPACT_RISK.HIGH
      const character = (project.entities || []).find(e => e.id === change.entityId)
      for (const c of metas) {
        if ((c.cast || []).includes(change.entityId) || (character && (c.cast || []).includes(character.name))) mark(c,'角色出场')
      }
      if (change.kind === 'rename') {
        for (const ch of project.chapters || []) if (ch.status === 'committed' && character?.name && String(ch.text || '').includes(character.name)) {
          if (!affected.has(ch.no)) references.push({chapterNo:ch.no,why:'历史正文保留旧名',committed:true})
        }
      }
      tags.push('character')
      break
    }
    case 'foreshadow_add': case 'foreshadow_remove': {
      // 增删伏笔都会改变「将来要安排什么」 ⇒ 高风险 + 需要重排未来章节
      risk = 'high'; replan = true; tags.push('foreshadow')
      for (const c of future(project)) mark(c, change.kind === 'foreshadow_add' ? '新伏笔需要排期' : '删掉的伏笔要从计划里摘掉')
      break
    }
    case 'foreshadow': {
      risk = 'high'; tags.push('foreshadow')
      if (change.field === 'safeReveal') {
        /**
         * 回收披露授权 / 撤回：只改变「这条伏笔被回收时能对读者说什么」，
         * 不改变任何章节的计划内容 ⇒ **不置 `pendingReplan`**。
         * 否则会冻结整个作品、强制跑一次毫无必要的全局重排
         * （而 `pendingReplan` 的语义是「真有未来章节计划要重排」）。
         * 仍然算高风险：它会改变将来正文里能出现的内容，必须走「预览 → 确认」。
         */
        const f = (project.outline?.foreshadows || []).find(x => x.id === change.foreshadowId)
        const no = Number(f?.payoffChapter ?? f?.revealAt)
        const meta = Number.isInteger(no) ? findChapterMeta(project.outline, no) : null
        if (meta) mark(meta, change.value ? '回收披露授权' : '撤回回收披露授权')
        tags.push('foreshadow-reveal')
      } else {
        replan = true
        for (const c of metas) if ((c.foreshadows || []).some(f => f.id === change.foreshadowId)) mark(c,'伏笔绑定')
      }
      break
    }
    case 'theme': case 'act': case 'world': case 'plot_direction': case 'target_chapters': {
      risk = 'high'; replan = true; tags.push('structure')
      for (const c of future(project)) mark(c,'未来规划')
      break
    }
    case 'chapter_title': {
      const meta=findChapterMeta(project.outline,change.chapterNo)
      if (meta) mark(meta,'章节标题')
      tags.push('chapter');break
    }
    case 'preferences': case 'preferences_bulk': tags.push('preferences'); break
    case 'book_title': case 'reader_intro': tags.push('display'); break
    default: throw new Error('不支持的修改类型')
  }
  // 中风险改名等已经有冻结版本和冲突门禁，用户仍须确认。
  return { risk, action:replan ? 'replan' : 'commit', requiresConfirm:true,
    replan, affectedChapters:[...affected].sort((a,b)=>a-b), references:references.slice(0,200),
    committedChapterCount:references.filter(r=>r.committed).length, tags,
    warning:replan ? '确认后只修订作者设定，已定稿正文不改动。必须先完成未写章节重排才能继续生成。' : '确认后更新作者设定，不会替换已定稿正文。' }
}
