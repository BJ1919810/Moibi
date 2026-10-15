/**
 * 开书自动补全回归测试（零成本，纯函数）。
 *
 * 背景（主人反馈）：
 *   ① 创书时没填文风/世界观，模型生成的也没回填 ⇒ 抽屉里永远是空的；
 *   ② 创书页根本没有「核心目标 / 禁止描写 / 结局偏好 / 主角设定」输入入口，
 *      模型给了也没落盘。
 * 这两个 bug 的共同根因是「模型产出 → 项目字段」之间缺了一步合并，
 * 下面把合并规则（applyGeneratedPreferences / applyGeneratedWorldview）钉死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyGeneratedPreferences, applyGeneratedWorldview, isMeaningful, missingSettingFields } from '../server/pipeline.js'

const project = (extra = {}) => ({ id: 'p_t', preferences: {}, preferenceSources: {}, ...extra })

test('占位内容不算有实义', () => {
  for (const v of ['', '   ', null, undefined, '待定', '暂无', '略', '同上', 'N/A', '未提供', '无', '—'])
    assert.equal(isMeaningful(v), false, `应判为占位：${JSON.stringify(v)}`)
  for (const v of ['江户末期的临江小城', '第三人称限知']) assert.equal(isMeaningful(v), true)
})

test('文风：用户填的是旧键 style ⇒ 提升到 styleSpec（抽屉才读得到）', () => {
  const p = project({ preferences: { style: '冷峻克制' }, preferenceSources: { style: 'user' } })
  applyGeneratedPreferences(p, { style: '模型自拟的文风' })
  assert.equal(p.preferences.styleSpec, '冷峻克制')
  assert.equal(p.preferenceSources.styleSpec, 'user')
  // 用户填过，模型不得覆盖
  assert.notEqual(p.preferences.styleSpec, '模型自拟的文风')
})

test('文风：用户完全没填 ⇒ 回填模型生成的 style', () => {
  const p = project()
  applyGeneratedPreferences(p, { style: '第三人称限知；短句为主' })
  assert.equal(p.preferences.styleSpec, '第三人称限知；短句为主')
  assert.equal(p.preferenceSources.styleSpec, 'outline')
})

test('文风：用户填的是 styleSpec ⇒ 保持不动', () => {
  const p = project({ preferences: { styleSpec: '第一人称' }, preferenceSources: { styleSpec: 'user' } })
  applyGeneratedPreferences(p, { style: '别的' })
  assert.equal(p.preferences.styleSpec, '第一人称')
})

test('偏好四项：模型给了就补齐，来源标 outline', () => {
  const p = project()
  applyGeneratedPreferences(p, {
    preferences: { coreGoal: '查明父亲旧案', forbidden: '不写穿越；不出系统面板', ending: '开放式和解', protagonist: '沉默的档案员' },
  })
  assert.equal(p.preferences.coreGoal, '查明父亲旧案')
  assert.equal(p.preferences.forbidden, '不写穿越；不出系统面板')
  assert.equal(p.preferences.ending, '开放式和解')
  assert.equal(p.preferences.protagonist, '沉默的档案员')
  for (const k of ['coreGoal', 'forbidden', 'ending', 'protagonist']) assert.equal(p.preferenceSources[k], 'outline')
})

test('偏好四项：用户填过的一律不覆盖', () => {
  const p = project({
    preferences: { ending: '悲剧收场' },
    preferenceSources: { ending: 'user' },
  })
  applyGeneratedPreferences(p, { preferences: { ending: '大团圆', coreGoal: '复仇' } })
  assert.equal(p.preferences.ending, '悲剧收场')           // 用户意图优先
  assert.equal(p.preferences.coreGoal, '复仇')             // 没填的照补
})

test('偏好四项：模型给占位内容时不写脏数据', () => {
  const p = project()
  applyGeneratedPreferences(p, { preferences: { coreGoal: '待定', forbidden: '', ending: null, protagonist: '略' } })
  assert.deepEqual(p.preferences, {})
})

test('世界观：用户填了永不覆盖；没填则用模型生成的补齐', () => {
  const a = project({ authorWorldRules: '我定的：只有一座孤岛' })
  applyGeneratedWorldview(a, { worldview: '模型自拟的世界' })
  assert.equal(a.authorWorldRules, '我定的：只有一座孤岛')

  const b = project()
  applyGeneratedWorldview(b, { worldview: '江户末期，武士与商贾共存。' })
  assert.equal(b.authorWorldRules, '江户末期，武士与商贾共存。')

  const c = project()
  applyGeneratedWorldview(c, { worldview: '待定' })
  assert.equal(c.authorWorldRules, undefined)
})

test('两者可重复调用（幂等），不会把 outline 来源误标成 user', () => {
  const p = project()
  const outline = { style: '短句', worldview: '临江小城', preferences: { coreGoal: '查案' } }
  applyGeneratedPreferences(p, outline)
  applyGeneratedWorldview(p, outline)
  const snapshot = JSON.stringify(p)
  applyGeneratedPreferences(p, outline)
  applyGeneratedWorldview(p, outline)
  assert.equal(JSON.stringify(p), snapshot)
  assert.equal(p.preferenceSources.styleSpec, 'outline')
  assert.equal(p.preferenceSources.coreGoal, 'outline')
})

/* --------------------------- 兜底补全的触发条件 --------------------------- */

test('空缺检测：全空 ⇒ 六项都要补', () => {
  assert.deepEqual(missingSettingFields(project()).sort(),
    ['coreGoal', 'ending', 'forbidden', 'protagonist', 'style', 'worldview'].sort())
})

test('空缺检测：已填齐 ⇒ 一项都不用补（也就不多花钱调模型）', () => {
  const p = project({
    authorWorldRules: '临江小城',
    preferences: { styleSpec: '短句', coreGoal: '查案', forbidden: '不写穿越', ending: '和解', protagonist: '档案员' },
  })
  assert.deepEqual(missingSettingFields(p), [])
})

test('空缺检测：用户手填过的字段即使内容潦草也算「用户负责」，不再自动补', () => {
  const p = project({
    preferences: { ending: '就这样吧' },
    preferenceSources: { ending: 'user' },
    authorWorldRules: '临江小城',
    // 其余三项齐、style 缺
    preferences2: null,
  })
  p.preferences = { ending: '就这样吧', styleSpec: '短句', coreGoal: '查案', forbidden: '不写穿越', protagonist: '档案员' }
  assert.deepEqual(missingSettingFields(p), [])
})

test('空缺检测：模型来源的占位内容仍算空缺（会触发补全）', () => {
  const p = project({
    authorWorldRules: '待定',
    preferences: { styleSpec: '略', coreGoal: '', forbidden: '无', ending: null, protagonist: ' ' },
    preferenceSources: { styleSpec: 'outline', coreGoal: 'outline' },
  })
  const miss = missingSettingFields(p)
  assert.ok(miss.includes('worldview'))
  assert.ok(miss.includes('style'))
  assert.ok(miss.includes('coreGoal'))
  assert.ok(miss.includes('ending'))
  assert.ok(miss.includes('protagonist'))
})
