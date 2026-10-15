import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, emptyLedger } from '../server/schema.js'
import { updateAuthorSettings } from '../server/author-control.js'

function book() {
  const e = makeEntity({ name: '顾行舟', publicIdentity: '档案志愿者', authorRole: '配角' })
  return { id: 'p_edit', headVersion: 2, editRevision: 0, targetChapters: 34, chapters: [{ no: 1, text: '顾行舟在雨夜出现。', status: 'committed' }],
    entities: [e], ledger: emptyLedger(), outline: { cast: [{ name: e.name, entityId: e.id }], totalChapters: 34, style: '阴郁',
      volumes: [{ title: '卷一', chapters: [{ no: 1, cast: [e.id] }, { no: 2, cast: [e.id] }] }] } }
}

test('定向改名保留稳定实体 ID 与旧别名，不静默覆盖历史正文', () => {
  const p = book(), id = p.entities[0].id
  const r = updateAuthorSettings(p, { rename: { entityId: id, name: '顾川' } }, 0)
  assert.equal(r.entities[0].id, id)
  assert.deepEqual(r.entities[0].aliases, ['顾行舟'])
  assert.equal(r.outline.cast[0].name, '顾川')
  assert.equal(r.chapters[0].text, '顾行舟在雨夜出现。')
  assert.equal(r.editRevision, 1)
  assert.equal(p.entities[0].name, '顾行舟')
})

test('文风/章节数修改保留已写章节，标记未来需重排，并记录用户来源', () => {
  const r = updateAuthorSettings(book(), { preferences: { style: '克制短句', forbidden: '禁止魔法' }, targetChapters: 60 }, 0)
  assert.equal(r.preferences.style, '克制短句')
  assert.equal(r.preferenceSources.style, 'user')
  assert.equal(r.targetChapters, 60)
  assert.equal(r.pendingReplan, true)
  assert.equal(r.chapters[0].status, 'committed')
  assert.equal(r.outline.totalChapters, 34, '重排前原有规划仍保留，不虚构新章节')
})

test('乐观锁：用户第二个编辑基于旧版本不得覆盖', () => {
  assert.throws(() => updateAuthorSettings(book(), { preferences: { style: '轻快' } }, 1), /版本冲突/)
})
