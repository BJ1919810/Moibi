import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCastIds, canonName } from '../server/schema.js'
import { normalizeOutline } from '../server/pipeline.js'

/**
 * 开书路径的角色名归一：原来**零 canon、零别名、还静默丢弃**。
 *
 * 现场：`pipeline.normalizeOutline` 里写的是
 *   `cast.map(n => nameToId.get(String(n).trim())).filter(Boolean)`
 * 而重排路径的 `normalizeCastIds` 早就有 canon（`林 奇`/`LIN QI`）+ 别名匹配 + 一条 warning。
 * ⇒ 同一份数据在两条路径上的角色可见性不同；被丢掉的名字**没有任何痕迹**。
 * 修法：两条路径共用 `schema.normalizeCastIds`，未识别的名字记在章节上（`castUnresolved`），
 * 并由 workflow 变成大纲页的标记（`contextNotes`）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const entities = [
  { id: 'ent_a', kind: 'character', name: '林奇', aliases: ['林队', 'LIN QI'] },
  { id: 'ent_b', kind: 'character', name: '赵甲', aliases: [] },
]

test('canon 归一：空格/连字符/大小写漂移都能认出来', () => {
  assert.equal(canonName('林 奇'), canonName('林奇'))
  assert.equal(canonName('LIN-QI'), canonName('linqi'))
  const r = normalizeCastIds(['林 奇', 'lin qi', '林队', '赵甲'], { entities }, [])
  assert.deepEqual(r.ids.sort(), ['ent_a', 'ent_b'])
  assert.deepEqual(r.unresolved, [], '能认出来的不该进 unresolved')
})

test('⛔ 认不出来的名字**不静默**：进 unresolved 且记一条 warning', () => {
  const warnings = []
  const r = normalizeCastIds(['林奇', '渡航', '渡航'], { entities }, warnings)
  assert.deepEqual(r.ids, ['ent_a'])
  assert.deepEqual(r.unresolved, ['渡航'], '重复的名字要去重')
  assert.equal(warnings.length, 1, '每个未识别名字记一条，且不重复记')
  assert.match(warnings[0], /引用了不存在的角色/)
})

test('空值/非字符串不炸，也不产生噪音', () => {
  const warnings = []
  const r = normalizeCastIds([null, 42, '  ', ''], { entities }, warnings)
  assert.deepEqual(r, { ids: [], unresolved: [] })
  assert.deepEqual(warnings, [])
  assert.deepEqual(normalizeCastIds(null, { entities }, []), { ids: [], unresolved: [] })
})

test('开书路径端到端：识别得了的进 cast，识别不了的进 castUnresolved（不再静默丢弃）', () => {
  const raw = {
    acts: [], foreshadows: [], theme: 't',
    cast: [
      { name: '林奇', publicRole: '队长', publicIdentity: '刑警' },
      { name: '赵甲', publicRole: '搭档', publicIdentity: '警员' },
    ],
    volumes: [{ title: '卷一', goal: 'g', chapters: [
      { no: 1, title: '开端', summary: 's', cast: ['林 奇', '赵甲'] },
      { no: 2, title: '继续', summary: 's', cast: ['赵甲', '渡航'] },
    ] }],
  }
  // ⚠️ `normalizeOutline` 返回的是 `{ outline, entities }`（不是 outline 本身）
  const { outline } = normalizeOutline(raw, 2)
  const ch1 = outline.volumes[0].chapters.find((c) => c.no === 1)
  const ch2 = outline.volumes[0].chapters.find((c) => c.no === 2)
  assert.equal(ch1.cast.length, 2, `「林 奇」应当被 canon 归一认出来：${JSON.stringify(ch1.cast)}`)
  assert.deepEqual(ch1.castUnresolved, [])
  assert.equal(ch2.cast.length, 1, '认不出来的不能进 cast（否则 projection 会判悬空引用而整章写不了）')
  assert.deepEqual(ch2.castUnresolved, ['渡航'], '但必须记下来，供界面显示')
})

test('⛔ 防复发：开书路径不许再自己算 cast 映射（源码扫描旧写法）', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server/pipeline.js'), 'utf8')
  assert.doesNotMatch(text, /\.map\(\(n\) => nameToId\.get\(String\(n\)\.trim\(\)\)\)/,
    '开书路径又出现了「只 trim + filter(Boolean)」的旧写法（零 canon、零别名、静默丢人）')
  assert.match(text, /normalizeCastIds\(/, '开书路径必须用唯一实现 schema.normalizeCastIds')
  const replan = fs.readFileSync(path.join(ROOT, 'server/replan.js'), 'utf8')
  assert.doesNotMatch(replan, /function normalizeCastIds\(/, '重排路径不许再自己留一份实现')
})
