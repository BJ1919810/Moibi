/**
 * L0 创作偏好与定向修改。
 * 人物用稳定实体 ID 关联；作者明确指定的偏好单独标明来源，不能由模型默认建议覆盖。
 * 已确认的正文不可被编辑器静默替换；改章节数先标记待重排，不能仅改计数假装已经规划。
 */
import { validateChapterCount, DEFAULT_CHAPTERS } from './creative-options.js'
import { hasFutureChaptersToReplan } from './change-impact.js'

/**
 * 作者偏好白名单。
 *
 * styleSpec 是 style / tone / pace 三项的**合并字段**（2026-10-12 主人定）：
 * 三者本质上都在描述「怎么写」，分开填既重复又难保持一致，统一成一个
 * 「文风设定」输入框。旧字段仍保留在白名单里，用于读取历史数据，
 * 但 UI 不再分别暴露；prompt 侧按 styleSpec → 旧三字段 的顺序回退。
 */
export const ALLOWED_PREFS = new Set(['styleSpec', 'style', 'tone', 'pace', 'protagonist', 'ending', 'forbidden', 'coreGoal'])
export const PREF_BUDGET = 2400
export function updateAuthorSettings(project, patch, expectedEditRevision = null) {
  if (expectedEditRevision != null && Number(project.editRevision || 0) !== Number(expectedEditRevision)) throw new Error('偏好修订版本冲突')
  const next = structuredClone(project)
  let changed = false
  if (patch.rename) {    const { entityId, name } = patch.rename
    const entity = (next.entities || []).find((e) => e.id === entityId)
    const candidate = String(name || '').trim()
    if (!entity || candidate.length < 1 || candidate.length > 32) throw new Error('人物或名称无效')
    if (next.entities.some((x) => x.id !== entityId && (x.name === candidate || x.aliases?.includes(candidate)))) throw new Error('人物名称或别名重复')
    const old = entity.name
    if (old !== candidate) {
      entity.aliases = [...new Set([...(entity.aliases || []), old])].filter((x) => x !== candidate)
      entity.name = candidate
      for (const c of next.outline?.cast || []) if (c.entityId === entityId) c.name = candidate
      // 已确认正文仍保留旧名字，避免未经授权的全量文字替换。
      changed = true
    }
  }
  if (patch.preferences && typeof patch.preferences === 'object') {
    next.preferences ||= {}
    next.preferenceSources ||= {}
    for (const [key, value] of Object.entries(patch.preferences)) {
      if (!ALLOWED_PREFS.has(key)) continue
      // 合并后的文风设定更长，单独给预算；其余字段仍限 1200 字。
      const limit = key === 'styleSpec' ? PREF_BUDGET : 1200
      if (typeof value !== 'string' || value.length > limit) throw new Error(`偏好 ${key} 无效（不超过 ${limit} 字）`)
      if (next.preferences[key] !== value.trim()) {
        next.preferences[key] = value.trim()
        next.preferenceSources[key] = 'user'
        changed = true
      }
    }
  }
  if (patch.targetChapters != null) {
    const written = Math.max(0, ...(next.chapters || []).filter((ch) => ch.status === 'committed').map((ch) => ch.no))
    const target = validateChapterCount(patch.targetChapters, written)
    if (Number(next.targetChapters ?? DEFAULT_CHAPTERS) !== target) {
      next.targetChapters = target
      // ⛔ 这里曾经**无条件**置 `pendingReplan`，绕过了 applyChange 的判据
      //    （`replan && affectedChapters.length > 0`）⇒ 在「开书失败（无大纲）」或
      //    「全书已定稿」的作品上改目标章数，会置位一个**没有未来章节可重排**的标志：
      //    界面立刻显示「后续正文已暂停生成」，而重排又会拒绝 ⇒ **彻底卡死**
      //    （唯一出路「重新生成大纲」还会丢掉现有大纲）。
      //    ⚠️ 不能直接删掉这一行：还有第二个调用方（assistant.js 的 chapter_count 不走 applyChange）。
      //    所以保留置位，但**按同一个精神加上边界**：只有真有未来章节时才冻结作品。
      if (hasFutureChaptersToReplan(next)) next.pendingReplan = true
      changed = true
    }
  }
  if (changed) {
    next.editRevision = Number(next.editRevision || 0) + 1
    next.editHistory ||= []
    next.editHistory.push({ revision: next.editRevision, at: new Date().toISOString(), fields: Object.keys(patch) })
  }
  return next
}

/** 创建时不增加输入负担；只有用户明确指定的字段才进入 user 来源。 */
export function initialPreferences(input = {}) {
  const preferences = {}, preferenceSources = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (!ALLOWED_PREFS.has(key) || typeof value !== 'string' || !value.trim()) continue
    preferences[key] = value.trim().slice(0, 1200)
    preferenceSources[key] = 'user'
  }
  return { preferences, preferenceSources }
}
