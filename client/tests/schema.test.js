import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCHEMA_VERSION,
  entityId,
  factId,
  threadId,
  normalizeText,
  makeEntity,
  makeFact,
  makeState,
  makeKnowledge,
  makeThread,
  emptyLedger,
  validateProject,
} from '../server/schema.js'

/* --------------------- ID 确定性（迁移幂等的基础） --------------------- */

test('同一输入必然产出同一实体 ID（迁移可重复执行）', () => {
  const a = entityId('character', '顾行舟')
  const b = entityId('character', '顾行舟')
  assert.equal(a, b)
  assert.match(a, /^ent_[0-9a-f]{10}$/)
})

test('不同名字 / 不同类别产出不同 ID', () => {
  assert.notEqual(entityId('character', '顾行舟'), entityId('character', '沈砚'))
  assert.notEqual(entityId('character', '青江桥'), entityId('place', '青江桥'))
})

test('名字两侧空白不影响 ID', () => {
  assert.equal(entityId('character', '顾行舟'), entityId('character', '  顾行舟  '))
})

test('事实 ID 对句末标点与空白不敏感（避免同义重复）', () => {
  assert.equal(factId('沈砚收到一封信'), factId('沈砚收到一封信。'))
  assert.equal(factId('沈砚收到一封信'), factId(' 沈砚 收到一封信 '))
})

test('内容不同则 ID 不同', () => {
  assert.notEqual(factId('沈砚收到一封信'), factId('沈砚寄出一封信'))
})

test('normalizeText 去掉句末标点与空白，但不动引号', () => {
  assert.equal(normalizeText('沈砚收到一封信。'), '沈砚收到一封信')
  assert.equal(normalizeText('  沈砚 收到一封信 '), '沈砚收到一封信')
  // 末尾是引号时不应被当作句末标点切掉
  assert.equal(normalizeText('他说：“可以。”'), '他说：“可以。”')
  assert.equal(normalizeText('甲、乙'), '甲、乙')
})

/* ---------------------------- 工厂函数结构 ---------------------------- */

test('makeEntity 生成完整结构且别名默认为空', () => {
  const e = makeEntity({ name: '顾行舟', publicRole: '档案馆志愿者' })
  assert.equal(e.kind, 'character')
  assert.equal(e.name, '顾行舟')
  assert.deepEqual(e.aliases, [])
  assert.equal(e.secret, null)
  assert.equal(e.publicRole, '档案馆志愿者')
  assert.ok(e.createdAt)
})

test('makeFact 记录出处与可见性，默认 verified 为 true（新建的即为已确认）', () => {
  const f = makeFact({ text: '铜钥匙归林舟所有', sourceChapter: 5, entityIds: ['ent_x'] })
  assert.equal(f.sourceChapter, 5)
  assert.equal(f.visibility, 'public')
  assert.equal(f.verified, true)
  assert.equal(f.status, 'active')
  assert.deepEqual(f.entityIds, ['ent_x'])
})

test('makeState / makeKnowledge / makeThread 结构正确', () => {
  const s = makeState({ subjectId: 'ent_a', attribute: '持有', value: '铜钥匙', sinceChapter: 3 })
  assert.equal(s.status, 'active')
  assert.equal(s.attribute, '持有')

  const k = makeKnowledge({ characterId: 'ent_a', fact: '陈墨是兄长', belief: 'suspects' })
  assert.equal(k.belief, 'suspects')

  const t = makeThread({ text: '信封上的邮戳来自城南邮局', status: 'planted', plantedAt: 10 })
  assert.equal(t.status, 'planted')
  assert.deepEqual(t.reinforcedAt, [])
  assert.equal(t.paidOffAt, null)
})

test('emptyLedger 五类齐全且为空（R2 加入态事件日志）', () => {
  const l = emptyLedger()
  assert.deepEqual(Object.keys(l).sort(), [
    'canonicalFacts',
    'characterKnowledge',
    'currentState',
    'foreshadowEvents',
    'plotThreads',
    'stateEvents',
  ])
  for (const v of Object.values(l)) assert.deepEqual(v, [])
})

/* ------------------------------- 校验 ------------------------------- */

const baseProject = () => ({
  schemaVersion: SCHEMA_VERSION,
  headVersion: 1,
  entities: [
    makeEntity({ name: '沈砚' }),
    makeEntity({ name: '顾行舟' }),
  ],
  outline: {
    cast: [{ entityId: entityId('character', '沈砚') }],
    volumes: [
      {
        title: '卷一',
        chapters: [
          { no: 1, title: '雨夜投递', cast: [entityId('character', '沈砚')] },
        ],
      },
    ],
  },
  ledger: emptyLedger(),
  migrations: [],
})

test('结构完整的项目校验通过', () => {
  assert.deepEqual(validateProject(baseProject()), [])
})

test('章节 cast 引用不存在的实体会被检出', () => {
  const p = baseProject()
  p.outline.volumes[0].chapters[0].cast.push('ent_deadbeef00')
  const issues = validateProject(p)
  assert.ok(issues.some((s) => s.includes('ent_deadbeef00')))
})

test('账本条目引用不存在的实体会被检出', () => {
  const p = baseProject()
  p.ledger.canonicalFacts.push(makeFact({ text: '某事实', entityIds: ['ent_missing01'] }))
  p.ledger.currentState.push(makeState({ subjectId: 'ent_missing02', attribute: '持有', value: '钥匙' }))
  p.ledger.characterKnowledge.push(makeKnowledge({ characterId: 'ent_missing03', fact: 'x' }))
  const issues = validateProject(p)
  assert.equal(issues.filter((s) => s.includes('ent_missing')).length, 3)
})

test('实体 id 重复会被检出', () => {
  const p = baseProject()
  p.entities.push(makeEntity({ name: '沈砚' })) // 同名 → 同 ID
  const issues = validateProject(p)
  assert.ok(issues.some((s) => s.includes('重复')))
})
