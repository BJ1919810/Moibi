import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findLeaks } from '../server/projection.js'
import { auditWriterSummaries, normalizeOutline } from '../server/pipeline.js'
import { createChangeService } from '../server/change-request.js'
import { buildWriterPacket } from '../server/projection.js'
import { emptyLedger } from '../server/schema.js'

/**
 * ① 泄漏守卫的分层召回（旧版只比「按标点切的整句、且 ≥8 字」）
 * ② 概要审查的报告可判性（并列给出 payoff 侧的出处）
 * ③ `chapter_task_text`：**概要审查那条诊断的真实出口**（此前界面上改不了 writerSummary）
 */

/* ---------------- ① 阻断层：召回 + 不误报 ---------------- */

const project = (secret, payoff, seed = '一封旧信') => ({
  id: 'p_leak', title: 't',
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', publicIdentity: '警员', secret }],
  outline: { foreshadows: [{ id: 'f1', seed, payoff, plantChapter: 1, payoffChapter: 3 }], volumes: [] },
})
const packet = (text) => ({ task: { no: 3, foreshadows: [], authorizedReveals: [], summary: text }, cast: [], context: {}, work: {} })

test('阻断层召回：短 payoff（<8 字符）原样出现也要拦住（旧版 fragments 为空 ⇒ 漏过）', () => {
  const p = project('（无秘密）', '抽屉夹层有枪')
  const issues = findLeaks(packet('他打开抽屉夹层有枪，愣了一下。'), p)
  assert.ok(issues.some((i) => i.type === 'foreshadow-payoff'), JSON.stringify(issues))
})

test('阻断层召回：长秘密被抄了一半（≥6 实义字的连续片段）也要拦住', () => {
  const p = project('档案室的暗格藏着那封没有寄出的信', '（无回收真相）')
  const issues = findLeaks(packet('他在档案室的暗格藏着那封东西里翻了很久。'), p)
  assert.ok(issues.some((i) => i.type === 'entity-secret'), JSON.stringify(issues.map((x) => x.fragment)))
})

test('阻断层召回：同一句话被换了标点也要拦住（去标点干草堆，仅对 ≥6 实义字生效）', () => {
  const p = project('档案室的暗格藏着那封没有寄出的信', '（无回收真相）')
  const issues = findLeaks(packet('档案室的暗格，藏着那封没有寄出的信。'), p)
  assert.ok(issues.some((i) => i.type === 'entity-secret'), JSON.stringify(issues.map((x) => x.fragment)))
})

test('⛔ 阻断层不能误拒：4~5 字的通用短语（「所有策略」）不算泄漏，留给诊断层提醒', () => {
  const p = project('（无秘密）', '他掌握了所有策略并且知道每个人的弱点')
  const issues = findLeaks(packet('他把所有策略都讲了一遍。'), p)
  assert.deepEqual(issues, [], `通用短语不该阻断生成：${JSON.stringify(issues)}`)
})

test('公开面过滤：与 seed 一字不差的说法不算泄漏（否则公开线索会天天误报）', () => {
  const p = project('一封旧信', '（无回收真相）', '一封旧信')
  const issues = findLeaks(packet('桌上有一封旧信。'), p)
  assert.deepEqual(issues, [], JSON.stringify(issues))
})

/* ---------------- ② 诊断层：报告要能判真假 ---------------- */

test('概要审查的报告并列给出 payoff 侧的出处与重叠字数（作者才判得出真假）', () => {
  const f = { id: 'f1', seed: '心海偶尔会独自离开军营', payoff: '心海在城外的秘密基地里留着退路' }
  const volumes = [{ chapters: [{ no: 2, writerSummary: '心海去了秘密基地。', writerGoal: '让读者察觉异常' }] }]
  const audit = auditWriterSummaries(volumes, [f], { entities: [] })
  assert.ok(audit.length >= 1, JSON.stringify(audit))
  const hit = audit.find((x) => x.fragment.includes('秘密基地'))
  assert.ok(hit, JSON.stringify(audit))
  assert.ok(hit.payoffAround.includes('秘密基地'), `要给出 payoff 里的上下文：${hit.payoffAround}`)
  assert.equal(hit.overlap, hit.fragment.length)
})

/* ---------------- ③ chapter_task_text：诊断的真实出口 ---------------- */

const fixture = (t, mutate) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-task-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pf = path.join(dir, 'project.json')
  const base = {
    id: 'p_task', schemaVersion: 2, headVersion: 1, editRevision: 0, targetChapters: 3, title: 't',
    preferences: {},
    chapters: [{ no: 1, status: 'committed', text: '赵甲在门外等候。', summary: '开端' }],
    entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员' }],
    outline: {
      totalChapters: 3, plannedDetailThrough: 1,
      foreshadows: [], volumes: [{ title: '卷一', chapters: [
        { no: 1, title: '开端', summary: '开端', cast: ['ent_a'] },
        { no: 2, title: '继续', summary: '继续', cast: ['ent_a'],
          writerSummary: '赵甲去了秘密基地，掌握了所有策略。', writerGoal: '让异常被看见' },
        { no: 3, title: '收束', summary: '收束', cast: ['ent_a'] },
      ] }],
    },
    ledger: emptyLedger(),
  }
  fs.writeFileSync(pf, JSON.stringify(mutate ? mutate(structuredClone(base)) : base))
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

test('编辑本章写作任务：一次提交就改到位并视为作者批准，且**真的改变送正文的内容**', (t) => {
  const { repo, service } = fixture(t)
  // 改之前：未批准 ⇒ 正文只拿到保守占位（这就是「概要里的真相措辞」会漏出去的那条路）
  const before = buildWriterPacket(repo.getProject(), 2)
  assert.ok(!before.task.summary.includes('秘密基地'), '未批准时不该把表层概要给正文')

  const r = service.approve(service.create('p_task', {
    kind: 'chapter_task_text', chapterNo: 2,
    writerSummary: '赵甲按约定去了一处旧仓库取东西，没有多停留。',
    writerGoal: '让「有人来过」这件事被看见',
  }).id)
  const meta = r.project.outline.volumes[0].chapters.find((c) => c.no === 2)
  assert.equal(meta.writerTaskApproval, 'author-approved', '作者亲手写的就是批准')
  assert.deepEqual(r.diff.map((x) => x.label).sort(),
    ['第 2 章 · 本章目标（表层）', '第 2 章 · 写作任务（表层）'].sort())

  // 关键断言：改完之后，送正文的那段真的变了、并且不再含真相措辞
  const after = buildWriterPacket(repo.getProject(), 2)
  assert.match(after.task.summary, /旧仓库/)
  assert.doesNotMatch(after.task.summary, /秘密基地|所有策略/)
})

test('编辑写作任务的边界：已定稿章拒绝 / 两项都空拒绝', (t) => {
  const { service } = fixture(t)
  assert.throws(() => service.create('p_task', { kind: 'chapter_task_text', chapterNo: 1, writerSummary: 'x' }), /不能再改/)
  assert.throws(() => service.create('p_task', { kind: 'chapter_task_text', chapterNo: 2, writerSummary: '  ', writerGoal: '' }), /不能两项都为空/)
})
