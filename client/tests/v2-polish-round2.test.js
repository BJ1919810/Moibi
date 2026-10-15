/**
 * 本轮（2026-10-12）四项改动的针对性回归：
 *   1) 章标题去掉自带的中文序号前缀 —— 修「第1章 第一章 xxx」重复显示
 *   2) 世界观在大纲生成时自动落盘（用户不填也不该是空白）
 *   3) 文风/基调/节奏合并为 styleSpec，且旧的三个字段仍能被读到
 *   4) 「关系补充」文本 ↔ 结构化数组的双向转换（修 [object Object]）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { stripChapterTitlePrefix } from '../server/schema.js'
import { normalizeOutline, applyGeneratedWorldview } from '../server/pipeline.js'
import { preferenceLinesForTest } from '../server/prompts.js'
import { writerStyleBase } from '../server/projection.js'
import { parseRelations, applyChange } from '../server/change-request.js'

/* ---------------------- ① 章标题序号前缀 ---------------------- */

test('章标题：剥掉模型自带的中文序号前缀，保留真正的标题', () => {
  const cases = [
    ['第一章 撞飞会长的一百种方式', '撞飞会长的一百种方式'],
    ['第 1 章 撞飞会长的一百种方式', '撞飞会长的一百种方式'],
    ['第十二章·雨夜的信', '雨夜的信'],
    ['第 100 章：归来', '归来'],
    ['第三章、初遇', '初遇'],
  ]
  for (const [input, want] of cases) {
    assert.equal(stripChapterTitlePrefix(input), want, `输入「${input}」`)
  }
})

test('章标题：不含序号的标题原样保留，且不会产生空标题', () => {
  for (const t of ['撞飞会长的一百种方式', '待细化', '雨夜的信']) {
    assert.equal(stripChapterTitlePrefix(t), t)
  }
  // 标题本身就是序号（无实际名字）→ 保留原样，不能变成空串
  assert.equal(stripChapterTitlePrefix('第一章'), '第一章')
  assert.equal(stripChapterTitlePrefix(''), '')
  assert.equal(stripChapterTitlePrefix(null), '')
})

test('章标题：normalizeOutline 落盘时就已去重，UI 侧无需再处理', () => {
  const raw = {
    title: '测试书', theme: '主题',
    acts: [{ name: '第一幕', summary: '起' }],
    cast: [{ name: '甲', publicRole: '主角' }],
    volumes: [{ title: '第一卷', chapters: [
      { title: '第一章 开端', summary: 'a', cast: ['甲'] },
      { title: '第二章 发展', summary: 'b', cast: ['甲'] },
      { title: '第三章 收束', summary: 'c', cast: ['甲'] },
    ] }],
  }
  const { outline } = normalizeOutline(raw, 3)
  assert.deepEqual(outline.volumes[0].chapters.map((c) => c.title), ['开端', '发展', '收束'])
})

/* ---------------------- ② 世界观自动落盘 ---------------------- */

test('世界观：大纲返回 worldview 时写入 outline.worldview', () => {
  const raw = {
    title: '测试书', theme: '主题', worldview: '江户末期，武士与商贾共存，刀禁初行。',
    acts: [{ name: '第一幕', summary: '起' }],
    cast: [{ name: '甲', publicRole: '主角' }],
    volumes: [{ title: '第一卷', chapters: [{ title: '开端', summary: 'a', cast: ['甲'] }] }],
  }
  const { outline } = normalizeOutline(raw, 1)
  assert.equal(outline.worldview, '江户末期，武士与商贾共存，刀禁初行。')
})

test('世界观：模型没给时留空字符串（不抛错、不伪造）', () => {
  const raw = {
    title: '测试书', acts: [{ name: '第一幕', summary: '起' }],
    cast: [{ name: '甲', publicRole: '主角' }],
    volumes: [{ title: '第一卷', chapters: [{ title: '开端', summary: 'a', cast: ['甲'] }] }],
  }
  const { outline } = normalizeOutline(raw, 1)
  assert.equal(outline.worldview, '')
})

test('世界观：用户没填时自动落盘，不用手敲', () => {
  const project = { id: 'p_w' }   // 全新项目：authorWorldRules 为空
  applyGeneratedWorldview(project, { worldview: '江户末期，武士与商贾共存。' })
  assert.equal(project.authorWorldRules, '江户末期，武士与商贾共存。')
})

test('世界观：用户手填的是作者意图，绝不被模型输出覆盖', () => {
  const project = { id: 'p_w', authorWorldRules: '我定的：只有一座孤岛，没有海。' }
  applyGeneratedWorldview(project, { worldview: '模型自拟的另一个世界' })
  assert.equal(project.authorWorldRules, '我定的：只有一座孤岛，没有海。')
})

test('世界观：模型也没给时保持空缺（不写空串，避免误判为已设定）', () => {
  const project = { id: 'p_w' }
  applyGeneratedWorldview(project, { worldview: '' })
  assert.equal(project.authorWorldRules, undefined)
  applyGeneratedWorldview(project, null)
  assert.equal(project.authorWorldRules, undefined)
})

/* ---------------------- ③ 文风合并 ---------------------- */

test('文风：存在 styleSpec 时不再重复输出 style/tone/pace', () => {
  const lines = preferenceLinesForTest({ styleSpec: '冷峻克制，短句推进', style: '旧文风', tone: '旧基调', pace: '旧节奏', coreGoal: '找到真凶' })
  assert.match(lines, /文风设定：冷峻克制，短句推进/)
  assert.match(lines, /核心目标：找到真凶/)
  assert.doesNotMatch(lines, /旧文风|旧基调|旧节奏/)
})

test('文风：没有 styleSpec 时旧的三个字段仍照常输出（历史数据兼容）', () => {
  const lines = preferenceLinesForTest({ style: '第一人称', tone: '阴郁', pace: '缓慢' })
  assert.match(lines, /文风：第一人称/)
  assert.match(lines, /基调：阴郁/)
  assert.match(lines, /节奏：缓慢/)
})

test('文风：writerStyleBase 的优先级 styleSpec → 旧三字段 → 大纲 style', () => {
  const outline = { style: '大纲给的文风' }
  assert.equal(writerStyleBase({ preferences: { styleSpec: '合并后的' } }, outline), '合并后的')
  assert.equal(writerStyleBase({ preferences: { style: 'S', tone: 'T', pace: 'P' } }, outline), '文风：S；基调：T；节奏：P')
  assert.equal(writerStyleBase({ preferences: {} }, outline), '大纲给的文风')
  // 什么都没有 → 落到兜底默认，不能是空串（空串会让正文失去风格约束）
  assert.ok(writerStyleBase({ preferences: {} }, {}).length > 0)
})

/* ---------------------- ④ 关系补充双向转换 ---------------------- */

test('关系补充：名字 | 关系 | 备注 解析回结构化数组', () => {
  const text = '五十岚咲 | 学生会长/被撞对象 | 从冤家到互相理解\n星野遥 | 观察部部长 | 守护旧部志'
  const out = parseRelations(text)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { name: '五十岚咲', relation: '学生会长/被撞对象', note: '从冤家到互相理解' })
  assert.deepEqual(out[1], { name: '星野遥', relation: '观察部部长', note: '守护旧部志' })
})

test('关系补充：兼容全角竖线、缺列填空、丢弃无名字的行', () => {
  const out = parseRelations('甲｜朋友\n乙\n\n | 只有关系 |')
  assert.deepEqual(out, [
    { name: '甲', relation: '朋友', note: '' },
    { name: '乙', relation: '', note: '' },
  ])
  assert.deepEqual(parseRelations(''), [])
  assert.deepEqual(parseRelations(null), [])
})

test('关系补充：applyChange 落盘后仍是结构化数组，不是字符串', () => {
  const project = {
    id: 'p_rel', headVersion: 0, editRevision: 0, preferences: {},
    entities: [{ id: 'ent_a', kind: 'character', name: '甲', aliases: [], characterCard: { personality: '冷静' } }],
    outline: { theme: 't', acts: [], cast: [{ entityId: 'ent_a', name: '甲' }], foreshadows: [], volumes: [] },
    chapters: [],
  }
  const next = applyChange(project, {
    kind: 'character_field', entityId: 'ent_a', field: 'relationships',
    value: '乙 | 同学 | 互相竞争\n丙 | 老师 | 暗中关照',
  }, 'cr_test')

  const rel = next.entities[0].characterCard.relationships
  assert.ok(Array.isArray(rel), '必须落成数组，不能是字符串')
  assert.equal(rel.length, 2)
  assert.deepEqual(rel[0], { name: '乙', relation: '同学', note: '互相竞争' })
  assert.equal(rel[1].name, '丙')
  // 原有字段不能被这次修改抹掉
  assert.equal(next.entities[0].characterCard.personality, '冷静')
})
