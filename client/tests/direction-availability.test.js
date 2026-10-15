/**
 * 「剧情方向修改」与「世界观」的可用性回归（零成本）。
 *
 * BUG 背景（主人实测发现）：在「创作资料与编辑」之外新开的
 * 「剧情方向修改」独立页面里点「预览影响」，后端报 **没有作品大纲**。
 *
 * 根因：validateChange 把 plot_direction 与 theme 归到同一分支，
 * 三者共用一句 `if (!p.outline) throw new Error('没有作品大纲')`。
 * 但 plot_direction 与 world 都落在**作者侧独立字段**
 * （authorPlotDirection / authorWorldRules），根本不写 outline，
 * 本就不该要求大纲存在 —— 尤其大纲生成失败时，用户恰恰最需要
 * 写下方向再去重试/重排，不能被这道门禁挡在外面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateChange, applyChange } from '../server/change-request.js'

const noOutline = () => ({ id: 'p_t', editRevision: 0, authorPlotDirection: '', entities: [], preferences: {}, chapters: [] })
const withOutline = () => ({ ...noOutline(), outline: { theme: '旧主题', acts: [], volumes: [], foreshadows: [] } })

test('剧情方向：没有大纲也能校验通过（原 BUG）', () => {
  const c = validateChange(noOutline(), { kind: 'plot_direction', value: '接下来三章压住感情线' })
  assert.equal(c.kind, 'plot_direction')
  assert.equal(c.value, '接下来三章压住感情线')
})

test('剧情方向：没有大纲也能落盘到 authorPlotDirection', () => {
  const next = applyChange(noOutline(), { kind: 'plot_direction', value: '先查父亲的旧案' })
  assert.equal(next.authorPlotDirection, '先查父亲的旧案')
})

test('世界观：没有大纲也能校验通过并落盘到 authorWorldRules', () => {
  const c = validateChange(noOutline(), { kind: 'world', value: '只有一座孤岛，没有海' })
  assert.equal(c.kind, 'world')
  const next = applyChange(noOutline(), c)
  assert.equal(next.authorWorldRules, '只有一座孤岛，没有海')
})

test('主题：仍然需要大纲（写进 outline.theme，不该放宽）', () => {
  assert.throws(() => validateChange(noOutline(), { kind: 'theme', value: '新主题' }), /没有作品大纲/)
  // 有大纲时正常
  const c = validateChange(withOutline(), { kind: 'theme', value: '新主题' })
  assert.equal(applyChange(withOutline(), c).outline.theme, '新主题')
})

test('剧情方向：超长内容被拒绝（而不是被静默截断），且不写 outline', () => {
  const long = '甲'.repeat(3000)
  assert.throws(() => applyChange(noOutline(), { kind: 'plot_direction', value: long }), /2400/)
  // 边界内正常落盘
  const next = applyChange(noOutline(), { kind: 'plot_direction', value: '甲'.repeat(2400) })
  assert.equal(next.authorPlotDirection.length, 2400)
  assert.equal(next.outline, undefined)
})

test('剧情方向：空白内容被拒绝', () => {
  assert.throws(() => applyChange(noOutline(), { kind: 'plot_direction', value: '   ' }), /不能为空/)
})
