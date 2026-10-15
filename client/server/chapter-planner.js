/**
 * L2 逐章轻量计划：由已经过授权的 writer 字段组装，不复制作者侧秘密。
 * 性价比优先：普通章节使用确定性计划；存在披露或前置依赖时进入高风险分支，
 * 由后续编译器严格校验授权，不凭模型自由文本批准揭示。
 */
import { findChapterMeta, resolveCast } from './projection.js'

/**
 * 「这一章写起来有多大风险」的两级词表。
 *
 * ⛔ 与 `change-impact.js` 的 `IMPACT_RISK`（`low|medium|high`，**作者改动的影响风险**）
 *    **不是一回事**，但两边都用了字面量 `'high'` ⇒ 复制粘贴极容易串味。
 *    所以：① 字段改名为 `chapterRisk`（`run.plan.chapterRisk`），与 `impact.risk` 在名字上就分得开；
 *          ② 取值只用这里的常量，不在调用点写裸字符串。
 *    语义：有「已授权的秘密披露」或「本章要回收伏笔」⇒ high（正文要停在待确认，让人过一眼）。
 */
export const CHAPTER_RISK = { NORMAL: 'normal', HIGH: 'high' }

export function prepareChapterPlan(project, chapterNo) {
  const meta = findChapterMeta(project.outline, chapterNo)
  if (!meta) throw new Error(`找不到第 ${chapterNo} 章规划`)
  const cast = resolveCast(meta, project)
  if (cast.dangling.length) throw new Error(`本章引用了不存在的人物：${cast.dangling.join('、')}`)
  const requiredFactIds = [...new Set((meta.requiredFactIds || []).map(String))]
  const requiredThreadIds = [...new Set((meta.requiredThreadIds || []).map(String))]
  const risky = !!(meta.reveals?.length || meta.foreshadows?.some((x) => x.action === 'pay_off'))
  // 永不把 meta.summary / meta.goal 这种作者侧自由文本拷贝到规划结果。
  const approved = meta.writerTaskApproval === 'author-approved'
  return {
    chapterNo,
    baseHeadVersion: Number(project.headVersion || 0),
    chapterRisk: risky ? CHAPTER_RISK.HIGH : CHAPTER_RISK.NORMAL,
    requiredFactIds,
    requiredThreadIds,
    castIds: [...cast.ids],
    foreshadowActions: (meta.foreshadows || []).map(({ id, action }) => ({ id, action })),
    writerTask: {
      summary: approved ? String(meta.writerSummary || '') : '沿已确认的冲突线索推进人物行动。',
      goal: approved ? String(meta.writerGoal || '') : '交付可观察的局势变化，不披露未经授权的真相。',
      approved,
    },
    generatedBy: 'deterministic-l2-v1',
  }
}
