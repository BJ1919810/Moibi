import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChangeService, describeChange, previewChangeDiff } from '../server/change-request.js'
import { emptyLedger } from '../server/schema.js'

/**
 * 主人两条反馈的后端部分：
 *   ① 伏笔只能改、不能增删  ⇒ 新增 `foreshadow_add` / `foreshadow_remove`
 *   ② 助手说的「改了哪」太模糊 ⇒ `describeChange()` 由**程序**对比前后快照算出改动，
 *      存进审计事件（界面上的红点与「查看上个版本」都读它）
 */

const clone = structuredClone

const fresh = () => ({
  id: 'p_diff', schemaVersion: 2, headVersion: 1, editRevision: 0, targetChapters: 3, title: '旧书名',
  preferences: { styleSpec: '第三人称限知；冷峻克制。' },
  chapters: [{ no: 1, status: 'committed', text: '赵甲在门外等候。', summary: '开端' }],
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员',
    secret: '他其实是林晚的儿子', characterCard: { personality: '理性' } }],
  outline: {
    totalChapters: 3, plannedDetailThrough: 1, theme: '旧主题',
    foreshadows: [{ id: 'f1', seed: '一封没有署名的信', payoff: '信是老师写的',
      plantChapter: 2, payoffChapter: 3, linkStatus: 'explicit', prerequisiteEventIds: [] }],
    volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '开端', summary: '开端', cast: ['ent_a'] },
      { no: 2, title: '继续', summary: '继续', cast: ['ent_a'], foreshadows: [{ id: 'f1', action: 'plant', approved: true }] },
      { no: 3, title: '收束', summary: '收束', cast: ['ent_a'], foreshadows: [{ id: 'f1', action: 'pay_off', approved: false }] },
    ] }],
  },
  ledger: emptyLedger(),
})

function fixture(t, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-diff-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pf = path.join(dir, 'project.json')
  fs.writeFileSync(pf, JSON.stringify(mutate ? mutate(clone(fresh())) : fresh()))
  const repo = {
    getProject: () => JSON.parse(fs.readFileSync(pf, 'utf8')),
    getChange: (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'))) } catch { return null } },
    saveChange: (c) => { fs.writeFileSync(path.join(dir, c.id + '.json'), JSON.stringify(c)); return c },
    listChanges: () => [],
    commitProjectEdit(next, head, edit) {
      const cur = repo.getProject()
      if (cur.headVersion !== head || cur.editRevision !== edit || next.editRevision !== edit + 1) throw Error('冲突')
      fs.writeFileSync(pf, JSON.stringify(next)); return next
    },
    listRuns: () => [], saveRun: (r) => r, getRun: () => null,
  }
  return { repo, service: createChangeService(repo) }
}
const approve = (service, payload) => service.approve(service.create('p_diff', payload).id)

/* ---------------- ① 程序算 diff ---------------- */

test('describeChange：短值直接给内容，只有长文本才折叠成字数（红点要能看清改了什么）', () => {
  const before = fresh()
  const after = clone(before)
  after.preferences.styleSpec = '第一人称限知；日常感，长短交错。'
  const diff = describeChange(before, after, { kind: 'preferences', field: 'styleSpec' })
  assert.equal(diff.length, 1)
  assert.equal(diff[0].label, '文风设定')
  assert.deepEqual([diff[0].before, diff[0].after],
    ['第三人称限知；冷峻克制。', '第一人称限知；日常感，长短交错。'],
    '短文本必须原样给出 —— 折叠成「N 字」就看不出改了什么了')

  // 只有真正的长文本（>40 字）才折叠
  const d2 = describeChange({ ...before, authorWorldRules: '甲'.repeat(50) },
    { ...before, authorWorldRules: '乙'.repeat(60) }, { kind: 'world' })
  assert.deepEqual([d2[0].before, d2[0].after], ['50 字', '60 字'])

  after.title = '新书名'
  const short = describeChange(before, after, { kind: 'book_title', value: '新书名' })
  assert.deepEqual(short.map((x) => [x.label, x.before, x.after]), [['书名', '旧书名', '新书名']])
})

test('describeChange：改名与角色字段都能说清「哪个角色的哪个字段」', () => {
  const before = fresh()
  const after = clone(before)
  after.entities[0].name = '林川'
  after.entities[0].characterCard.personality = '执拗'
  const d1 = describeChange(before, after, { kind: 'rename', entityId: 'ent_a' })
  assert.equal(d1[0].label, '角色名「赵甲」')
  assert.deepEqual([d1[0].before, d1[0].after], ['赵甲', '林川'])
  const d2 = describeChange(before, after, { kind: 'character_field', entityId: 'ent_a', field: 'personality' })
  assert.equal(d2[0].label, '「赵甲」的性格')
  assert.deepEqual([d2[0].before, d2[0].after], ['理性', '执拗'])
})

test('previewChangeDiff 只在副本上试算：原作品一个字都不动', () => {
  const before = fresh()
  const snapshot = JSON.stringify(before)
  const diff = previewChangeDiff(before, { kind: 'preferences', field: 'styleSpec', value: '第一人称；冷。' })
  assert.ok(diff.length >= 1)
  assert.equal(JSON.stringify(before), snapshot, '试算不能改到原对象')
})

test('提交后 diff 会随审计事件留档，并随返回值给界面（红点与「上个版本」读它）', (t) => {
  const { repo, service } = fixture(t)
  const r = approve(service, { kind: 'character_field', entityId: 'ent_a', field: 'personality', value: '执拗' })
  assert.deepEqual(r.diff.map((x) => [x.label, x.before, x.after]), [['「赵甲」的性格', '理性', '执拗']])
  const p = repo.getProject()
  assert.deepEqual(p.editEvents.at(-1).diff, r.diff, '审计事件里必须留一份')
  assert.equal(r.request.diff.length, 1, '收据里也留一份')
})

/* ---------------- ② 伏笔新增 ---------------- */

test('新增伏笔：id 由线索铺设派生、写入大纲、章号留空等作者确认', (t) => {
  const { repo, service } = fixture(t)
  const r = approve(service, { kind: 'foreshadow_add', seed: '食堂阿姨总多给一勺', payoff: '她是主角的母亲' })
  const f = r.project.outline.foreshadows.find((x) => x.seed === '食堂阿姨总多给一勺')
  assert.ok(f, '新伏笔要真的进大纲')
  assert.equal(f.payoffChapter, null, '章号留空，等作者用「伏笔关联章号」确认')
  assert.equal(f.linkStatus, 'explicit')
  assert.ok(/^fs_/.test(f.id), `id 应由 seed 派生，实际 ${f.id}`)
  assert.equal(r.project.outline.foreshadows.length, 2)
  assert.deepEqual(r.diff.map((x) => x.label).sort(), ['回收真相', '新增伏笔（' + f.id + '）'].sort())

  // 同一句线索重复新增要被拒（id 派生天然去重）
  assert.throws(() => service.create('p_diff', { kind: 'foreshadow_add', seed: '食堂阿姨总多给一勺', payoff: '换个说法' }), /一模一样/)
  assert.equal(repo.getProject().outline.foreshadows.length, 2)
})

/* ---------------- ③ 伏笔删除 ---------------- */

test('删除伏笔：连同章节计划里的引用一起清掉，并把线索账本的外键置空', (t) => {
  const { repo, service } = fixture(t, (p) => {
    p.ledger.plotThreads = [{ id: 'th_1', text: '一封没有署名的信', foreshadowId: 'f1', status: 'open', trust: 'canonical' }]
    return p
  })
  const r = approve(service, { kind: 'foreshadow_remove', foreshadowId: 'f1' })
  assert.equal(r.project.outline.foreshadows.length, 0, '声明删掉')
  const refs = r.project.outline.volumes[0].chapters.flatMap((c) => c.foreshadows || [])
  assert.deepEqual(refs, [], '第 2/3 章计划里的引用必须一起清掉，否则是悬空引用')
  assert.equal(r.project.ledger.plotThreads[0].foreshadowId, null, '线索本身是正文里发生过的事，保留；外键置空')
  assert.equal(repo.getProject().ledger.plotThreads.length, 1)
})

test('⛔ 已经在正文里真实铺设/回收过的伏笔不许删（账本是已发生的事实）', (t) => {
  const { service } = fixture(t, (p) => {
    p.ledger.foreshadowEvents = [{ id: 'fe_1', foreshadowId: 'f1', action: 'plant', chapterNo: 2,
      status: 'accepted', trust: 'canonical', sourceVersion: 1, sourceSpan: { start: 0, end: 4, quote: '赵甲在' } }]
    return p
  })
  assert.throws(() => service.create('p_diff', { kind: 'foreshadow_remove', foreshadowId: 'f1' }), /不能删除/)
})
