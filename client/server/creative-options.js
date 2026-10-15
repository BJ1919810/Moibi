/**
 * 用户创作参数：只有配置与展示层引用本模块。
 * 正文阶段仍统一经过 projection.js；不在此处绕过安全投影。
 */
export const MIN_CHAPTERS = 1
export const MAX_CHAPTERS = 999
export const DEFAULT_CHAPTERS = 30
export const OUTLINE_WINDOW = 5

// v1 的 5 组 40 个标签，采用结构化数组保留组别；历史单字符串仍可识别。
export const GENRE_GROUPS = Object.freeze({
  background: ['玄幻','奇幻','仙侠','武侠','科幻','都市','历史','军事','悬疑','现实'],
  mechanism: ['系统流','废柴流','种田','基建','无限流','快穿','穿书','重生','末世','废土'],
  derivative: ['同人','二次元','轻小说'],
  tone: ['搞笑','轻松','热血','黑暗','甜宠','治愈','正剧','沙雕','虐心'],
  other: ['修真','青春校园','言情','恐怖','诡秘怪谈','灵气复苏','游戏','诸天无限'],
})
const ALL = new Set(Object.values(GENRE_GROUPS).flat())
export function normalizeGenreTags(tags, legacyGenre = '') {
  const given = Array.isArray(tags) ? tags : String(legacyGenre || '').split(/\s*\/\s*/)
  return [...new Set(given.map((t) => String(t).trim()).filter((t) => ALL.has(t)))].slice(0, 20)
}
export function primaryGenre(tags, legacyGenre = '玄幻') {
  return normalizeGenreTags(tags, legacyGenre).find((x) => GENRE_GROUPS.background.includes(x))
    || String(legacyGenre || '玄幻').split('/')[0].trim() || '玄幻'
}
export function genrePrompt(tags, legacyGenre = '玄幻') {
  const normalized = normalizeGenreTags(tags, legacyGenre)
  const label = {background: '主背景',mechanism: '叙事机制',derivative: '衍生形态',tone: '情绪基调',other: '补充标签'}
  return Object.entries(GENRE_GROUPS).map(([group, values]) => {
    const hits = normalized.filter((tag) => values.includes(tag))
    return hits.length ? `${label[group]}：${hits.join('、')}` : ''
  }).filter(Boolean).join('\n') || `主背景：${legacyGenre}`
}
export function validateChapterCount(value, written = 0) {
  const count = Number(value)
  if (!Number.isInteger(count) || count < MIN_CHAPTERS || count > MAX_CHAPTERS || count < written) {
    throw new Error(`目标章节数必须是 ${Math.max(MIN_CHAPTERS, written)}～${MAX_CHAPTERS} 的整数`)
  }
  return count
}
/** 
 * 只让 L1 细化开篇 5 章；中远期靠全书三幕/卷里程碑和逐章 L2 滚动规划。
 * 不把 999 章明细放进一次请求，避免 token 爆炸与截断。
 */
export function outlinePlanCount(target) { return Math.min(validateChapterCount(target), OUTLINE_WINDOW) }
export function estimateOutlineSeconds(target) {
  // 这只是用于提示的数量级估计，不承诺真实供应商耗时。
  const n = validateChapterCount(target)
  return { calls: 1, plannedNow: outlinePlanCount(n), deferred: Math.max(0,n-OUTLINE_WINDOW),
    label: n <= OUTLINE_WINDOW ? '一次性规划全部章节' : `先细化 ${OUTLINE_WINDOW} 章，其余按需滚动规划` }
}

/** 不包含单价的调用量级预估，避免在供应商价格未知时编造人民币费用。 */
export function estimateGenerationCalls(value) {
  const n = validateChapterCount(value)
  return { minimum: 1 + n * 2, maximum: 1 + n * 3, detail: n > OUTLINE_WINDOW ? `先细化 ${OUTLINE_WINDOW} 章，后面滚动展开` : `先细化 ${n} 章` }
}
