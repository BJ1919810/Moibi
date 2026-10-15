import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChangeService } from '../server/change-request.js'
import { buildWriterPacket } from '../server/projection.js'
import { revealDecision, chapterPlans } from '../server/foreshadow.js'
import { emptyLedger } from '../server/schema.js'

/**
 * 三条「作者批准」通道（2026-10-13 审计的三条 P0）。
 *
 * 它们的共同病根完全一样：**门禁在跑，写入方不存在**——
 * 提示让作者去「确认埋设/回收章」「批准本章任务」「授权披露角色秘密」，
 * 而界面上根本没有这些动作，于是能力整块不可达（或每章白花钱）。
 *
 * 这里锁住三件事：① 出路真的可达；② 只批角色级不够、必须一次写两处；
 * ③ 批准之后**进正文的仍然是安全版本**，原始 secret/payoff 绝不出现。
 */

const clone = structuredClone
const SECRET = '他其实是林晚的儿子'
const SAFE_TEXT = '赵甲终于想起了母亲的名字。'

const fresh = () => ({
  id: 'p_secret', schemaVersion: 2, headVersion: 1, editRevision: 0, targetChapters: 3, title: '披露测试',
  chapters: [{ no: 1, title: '开端', status: 'committed', text: '赵甲在门外等候。', summary: '开端' }],
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员', secret: SECRET }],
  outline: {
    totalChapters: 3, plannedDetailThrough: 1, theme: '真相',
    foreshadows: [{
      id: 'f1', seed: '一封没有署名的信', payoff: '信是老师写的',
      plantChapter: null, payoffChapter: null, linkStatus: 'needsReview', prerequisiteEventIds: [],
    }],
    volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '开端', summary: '开端', cast: ['ent_a'] },
      { no: 2, title: '继续', summary: '继续', cast: ['ent_a'],
        writerSummary: '赵甲把信放在桌上，没有拆。', writerGoal: '让信的存在被看见' },
      // 模型已经把回收排在第 3 章（approved 由计划侧给出），但这条伏笔的关联从没被审核过
      { no: 3, title: '收束', summary: '收束', cast: ['ent_a'],
        writerSummary: '赵甲读完信。', writerGoal: '揭开信的内容',
        foreshadows: [{ id: 'f1', action: 'pay_off', approved: true }] },
    ] }],
  },
  ledger: emptyLedger(),
})

function fixture(t, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-secret-'))
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
      fs.writeFileSync(pf, JSON.stringify(next))
      return next
    },
    listRuns: () => [], saveRun: (r) => r, getRun: () => null,
  }
  return { repo, service: createChangeService(repo) }
}

const metaOf = (p, no) => chapterPlans(p).find((c) => c.no === no)
const approve = (service, payload) => service.approve(service.create('p_secret', payload).id)
/** packet 里任务状态的落点（当前在 diagnostics.taskStatus，写成容忍式以免位置变动就假失败） */
const taskStatusOf = (pk) => pk.task?.taskStatus ?? pk.taskStatus ?? pk.diagnostics?.taskStatus

/* ---------------- ① 伏笔关联审核：把「不存在的出路」补上 ---------------- */

test('伏笔关联审核：作者确认埋设/回收章后，回收门禁才真正可达（审计 P0）', (t) => {
  // 账本里必须有**真实铺设过**的证据，否则审完关联也只是从「链接没审」推进到「还没埋过」
  const { repo, service } = fixture(t, (p) => {
    p.ledger.foreshadowEvents = [{ id: 'fe_p', foreshadowId: 'f1', action: 'plant', chapterNo: 2,
      status: 'accepted', trust: 'canonical', sourceVersion: 1, sourceSpan: { start: 0, end: 4, quote: '赵甲在' } }]
    return p
  })
  const before = repo.getProject()
  // 现状：模型排了回收，但这条伏笔的关联从没被审核过 ⇒ 判 unreviewed-link（那章写不出来）
  assert.equal(before.outline.foreshadows[0].linkStatus, 'needsReview')
  assert.equal(before.outline.foreshadows[0].payoffChapter, null)
  assert.equal(revealDecision(before, metaOf(before, 3), before.outline.foreshadows[0]).reason, 'unreviewed-link')

  const r = approve(service, { kind: 'foreshadow_link', foreshadowId: 'f1', plantChapter: 2, payoffChapter: 3 })
  const f = r.project.outline.foreshadows[0]
  assert.equal(f.linkStatus, 'explicit', '作者确认过就不再是待审核候选')
  assert.equal(f.plantChapter, 2)
  assert.equal(f.payoffChapter, 3)
  assert.equal(f.linkProposal.reviewer, 'owner')
  assert.equal(revealDecision(r.project, metaOf(r.project, 3), f).reason, 'authorized',
    '出路真的可达了：从 unreviewed-link 一路走到 authorized')
})

test('伏笔关联审核：章号越界 / 埋晚于收 / 两个都空 都要拒绝', (t) => {
  const { service } = fixture(t)
  assert.throws(() => service.create('p_secret', { kind: 'foreshadow_link', foreshadowId: 'f1', payoffChapter: 99 }), /规划内/)
  assert.throws(() => service.create('p_secret', { kind: 'foreshadow_link', foreshadowId: 'f1', plantChapter: 3, payoffChapter: 2 }), /不能晚于/)
  assert.throws(() => service.create('p_secret', { kind: 'foreshadow_link', foreshadowId: 'f1' }), /至少要填一个/)
})

/* ---------------- ② 章节任务批准：不再每章白付一次 L2 ---------------- */

test('批准本章任务后，作者付过钱的 writerSummary 才真的进正文（否则每章白付一次 L2）', (t) => {
  const { repo, service } = fixture(t)
  const before = buildWriterPacket(repo.getProject(), 2)
  assert.equal(taskStatusOf(before), 'safe-fallback', '未批准时只能给安全占位任务')
  assert.doesNotMatch(before.task.summary, /把信放在桌上/, '已付费的规划产物被丢掉了')

  const r = approve(service, { kind: 'chapter_task_approval', chapterNo: 2 })
  assert.equal(metaOf(r.project, 2).writerTaskApproval, 'author-approved')
  const after = buildWriterPacket(repo.getProject(), 2)
  assert.equal(taskStatusOf(after), 'approved')
  assert.match(after.task.summary, /赵甲把信放在桌上/)
  assert.match(after.task.goal, /让信的存在被看见/)
})

test('已定稿的章不需要（也不允许）再批准任务', (t) => {
  const { service } = fixture(t)
  assert.throws(() => service.create('p_secret', { kind: 'chapter_task_approval', chapterNo: 1 }), /不需要再批准/)
})

/* ---------------- ③ 角色秘密的可控披露：一次写两处 ---------------- */

test('角色秘密披露授权：必须一次写「角色级批准 + 章级揭示」，否则批了也进不了正文', (t) => {
  const { repo, service } = fixture(t)
  assert.deepEqual(buildWriterPacket(repo.getProject(), 2).task.authorizedReveals || [], [],
    '没授权之前，正文一个角色秘密都拿不到')

  const r = approve(service, { kind: 'entity_reveal_projection', entityId: 'ent_a', chapterNo: 2, value: SAFE_TEXT })
  const e = r.project.entities[0]

  // 角色级：批准了什么
  assert.equal(e.revealProjections.length, 1)
  assert.equal(e.revealProjections[0].approved, true)
  assert.equal(e.revealProjections[0].safeText, SAFE_TEXT)
  // 章级：什么时候揭示（只写角色级 ⇒ 正文永远拿不到，那正是这个坑本身）
  const reveals = metaOf(r.project, 2).reveals
  assert.equal(reveals.length, 1)
  assert.equal(reveals[0].projectionId, e.revealProjections[0].id)
  assert.equal(reveals[0].approved, true)
  assert.equal(reveals[0].notBeforeChapter, 2)

  // 投影结果：进去的是**安全文本**，不是原始 secret
  const packet = buildWriterPacket(repo.getProject(), 2)
  assert.deepEqual((packet.task.authorizedReveals || []).map((x) => x.safeText), [SAFE_TEXT])
  const text = JSON.stringify(packet)
  assert.ok(text.includes(SAFE_TEXT), '批准过的安全版本必须进正文')
  assert.ok(!text.includes(SECRET), '原始 secret 永远不进正文')

  // 同一段文本重复提交是幂等覆盖，不会堆垃圾
  const again = approve(service, { kind: 'entity_reveal_projection', entityId: 'ent_a', chapterNo: 2, value: SAFE_TEXT })
  assert.equal(again.project.entities[0].revealProjections.length, 1)
  assert.equal(metaOf(again.project, 2).reveals.length, 1)
})

test('角色秘密披露授权的边界：本章没这个角色 / 已定稿章 / 空文本 都拒绝', (t) => {
  const { service } = fixture(t, (p) => { p.outline.volumes[0].chapters[1].cast = []; return p })
  assert.throws(() => service.create('p_secret', { kind: 'entity_reveal_projection', entityId: 'ent_a', chapterNo: 2, value: SAFE_TEXT }), /没有「赵甲」出场/)
  assert.throws(() => service.create('p_secret', { kind: 'entity_reveal_projection', entityId: 'ent_a', chapterNo: 1, value: SAFE_TEXT }), /已定稿/)
  const other = fixture(t)
  assert.throws(() => other.service.create('p_secret', { kind: 'entity_reveal_projection', entityId: 'ent_a', chapterNo: 2, value: '  ' }), /不能为空/)
})

/* ---------------- 影响分析：都该冻结确认，但只有改排期的才要求重排 ---------------- */

test('三个新 kind 的影响分析：高风险 + 需要确认；只有改伏笔排期时才要求重排', (t) => {
  const { service } = fixture(t)
  const link = service.create('p_secret', { kind: 'foreshadow_link', foreshadowId: 'f1', plantChapter: 2, payoffChapter: 3 })
  assert.equal(link.impact.risk, 'high')
  assert.equal(link.impact.replan, true, '改了埋/收章 ⇒ 未来章节排期要跟着变')

  const task = service.create('p_secret', { kind: 'chapter_task_approval', chapterNo: 2 })
  assert.equal(task.impact.risk, 'high')
  assert.equal(task.impact.replan, false, '只改「这一章怎么写」，不改计划 ⇒ 不该强制全局重排')
  assert.deepEqual(task.impact.affectedChapters, [2])

  const reveal = service.create('p_secret', { kind: 'entity_reveal_projection', entityId: 'ent_a', chapterNo: 2, value: SAFE_TEXT })
  assert.equal(reveal.impact.risk, 'high')
  assert.equal(reveal.impact.replan, false)
  assert.deepEqual(reveal.impact.affectedChapters, [2])

  // 批准任务/披露秘密都不该冻结作品（否则又是一次「两头堵死」）
  assert.equal(approve(service, { kind: 'chapter_task_approval', chapterNo: 2 }).project.pendingReplan, undefined)
})
