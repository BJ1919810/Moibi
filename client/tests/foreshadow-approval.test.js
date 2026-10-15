import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChangeService } from '../server/change-request.js'
import { buildWriterPacket } from '../server/projection.js'
import { revealDecision } from '../server/foreshadow.js'
import { emptyLedger, TRUST } from '../server/schema.js'

/**
 * 伏笔回收授权（`foreshadow.safeReveal`）。
 *
 * 这里锁住的是那个「有读无写」的洞：
 * `projection.projectForeshadows()` 要求 `safeReveal.approved===true` 且有文本才放行 pay_off，
 * 而此前全项目**没有任何地方写入它**（唯一一处写入是把它置 null）⇒ 带伏笔的作品写到回收章
 * 永久卡在 `not-approved`（两轮真实压测的第 26–30 章与第 18 章现场，¥0，死在模型调用之前）。
 *
 * 现在唯一入口是 ChangeRequest 的 `{kind:'foreshadow', field:'safeReveal'}`（界面：
 * 创作资料与编辑 → 伏笔 → 回收披露授权）。填文本 = 授权，空文本 = 撤回。
 *
 * 同时锁住这条边界：**授权只放宽「谁批准了」，不放宽任何客观门禁**
 * （章号、前置事件、是否已真实铺设、关联状态），模型侧依旧无法自我授权。
 */

const clone = structuredClone
const planOf = (p, no) => (p.outline.volumes || []).flatMap(v => v.chapters || []).find(c => c.no === no)
const fsOf = (p) => p.outline.foreshadows[0]
const AUTHORIZED_TEXT = '可以对读者说出的版本：信是老师临死前写下的。'
const PAYOFF_TRUTH = '写信的人其实是已经死去的老师'

const fresh = () => ({
  id: 'p_test', headVersion: 1, editRevision: 0, schemaVersion: 2, targetChapters: 3, title: '测试书',
  preferences: {},
  chapters: [{ no: 1, title: '开端', status: 'committed', text: '赵甲在山谷里找到一封信。', summary: '第一章' }],
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员', characterCard: {} }],
  outline: {
    title: '测试书', totalChapters: 3, theme: '真相',
    acts: [{ name: '第一幕', summary: '起因' }, { name: '第二幕', summary: '转折' }, { name: '第三幕', summary: '结局' }],
    cast: [{ entityId: 'ent_a', name: '赵甲' }],
    foreshadows: [{
      id: 'fs_a', seed: '一封没有署名的信', payoff: PAYOFF_TRUTH,
      plantChapter: 2, payoffChapter: 3, revealAt: 3,
      linkStatus: 'explicit', prerequisiteEventIds: [], lifecycle: 'planted',
    }],
    volumes: [{ title: '第一卷', chapters: [
      { no: 1, title: '开端', summary: '开端', cast: ['ent_a'], foreshadows: [] },
      { no: 2, title: '继续', summary: '继续调查', cast: ['ent_a'], foreshadows: [{ id: 'fs_a', action: 'plant', approved: true }] },
      // ⚠️ 章计划里的回收动作一律 approved:false —— 模型无权自我批准（见 replan.js）
      { no: 3, title: '收束', summary: '真相揭开', cast: ['ent_a'], foreshadows: [{ id: 'fs_a', action: 'pay_off', approved: false }] },
    ] }],
  },
  ledger: {
    ...emptyLedger(),
    foreshadowEvents: [{
      id: 'fe_plant', foreshadowId: 'fs_a', action: 'plant', chapterNo: 2,
      status: 'accepted', trust: TRUST.CANONICAL, sourceVersion: 1,
      sourceSpan: { start: 0, end: 4, quote: '赵甲在' },
    }],
  },
})

function fixture(t, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-reveal-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pf = path.join(dir, 'project.json')
  fs.writeFileSync(pf, JSON.stringify(mutate ? mutate(clone(fresh())) : fresh()))
  const repo = {
    getProject: () => JSON.parse(fs.readFileSync(pf)),
    getChange: (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'))) } catch { return null } },
    saveChange: (c) => { fs.writeFileSync(path.join(dir, c.id + '.json'), JSON.stringify(c)); return c },
    listChanges: (id) => fs.readdirSync(dir).filter(f => f.startsWith('cr_'))
      .map(f => JSON.parse(fs.readFileSync(path.join(dir, f)))).filter(c => c.projectId === id),
    commitProjectEdit(next, head, edit) {
      const curr = repo.getProject()
      if (curr.headVersion !== head || curr.editRevision !== edit || next.editRevision !== edit + 1) throw Error('冲突')
      fs.writeFileSync(pf, JSON.stringify(next))
      return next
    },
    listRuns: () => [], saveRun: (r) => r, getRun: () => null,
  }
  return { repo, service: createChangeService(repo) }
}

const authorize = (service, value = AUTHORIZED_TEXT) =>
  service.create('p_test', { kind: 'foreshadow', foreshadowId: 'fs_a', field: 'safeReveal', value })

/* ---------------- 核心：这个洞本身 ---------------- */

test('未授权时回收章构建不出 WriterPacket（现场就是死在这一步）', t => {
  const { repo } = fixture(t)
  const p = repo.getProject()
  assert.equal(revealDecision(p, planOf(p, 3), fsOf(p)).reason, 'not-approved')
  assert.throws(() => buildWriterPacket(p, 3), /伏笔回收尚未授权.*not-approved/)
})

test('授权后回收章放行；正文只拿到 safeReveal，拿不到作者侧 payoff', t => {
  const { repo, service } = fixture(t)
  const r = authorize(service)
  assert.equal(r.impact.risk, 'high')
  service.approve(r.id)
  const p = repo.getProject()
  assert.equal(fsOf(p).safeReveal.approved, true)
  assert.equal(fsOf(p).safeReveal.text, AUTHORIZED_TEXT)
  assert.equal(revealDecision(p, planOf(p, 3), fsOf(p)).allowed, true)
  const text = JSON.stringify(buildWriterPacket(p, 3))
  assert.ok(text.includes(AUTHORIZED_TEXT), '批准过的披露文本要进正文任务')
  assert.ok(!text.includes(PAYOFF_TRUTH), '作者侧回收真相永远不进正文')
  assert.equal(fsOf(p).payoff, PAYOFF_TRUTH, '伏笔声明一字不改')
  assert.equal(planOf(p, 3).foreshadows.find(a => a.action === 'pay_off').approved, false,
    '作者的授权不冒充模型的计划批准 —— 两者是独立来源')
})

test('撤回授权：回收章重新被拦，伏笔声明与章计划一字不改', t => {
  const { repo, service } = fixture(t)
  service.approve(authorize(service).id)
  const before = clone(repo.getProject())
  const revoke = service.create('p_test', { kind: 'foreshadow', foreshadowId: 'fs_a', field: 'safeReveal', value: '   ' })
  assert.equal(revoke.change.value, '', '纯空白 = 撤回')
  service.approve(revoke.id)
  const p = repo.getProject()
  assert.equal(fsOf(p).safeReveal, null)
  assert.equal(revealDecision(p, planOf(p, 3), fsOf(p)).reason, 'not-approved')
  assert.throws(() => buildWriterPacket(p, 3), /not-approved/)
  assert.deepEqual(p.outline.volumes, before.outline.volumes)
  assert.equal(fsOf(p).payoff, before.outline.foreshadows[0].payoff)
})

/* ---------------- 边界：授权不放宽任何客观门禁 ---------------- */

test('授权不能绕过章号：计划把回收排错章，仍然 wrong-chapter', t => {
  const { repo, service } = fixture(t, p => {
    // 让第 2 章的计划里也排上 pay_off，但伏笔声明的回收章是第 3 章
    p.outline.volumes[0].chapters[1].foreshadows.push({ id: 'fs_a', action: 'pay_off', approved: false })
    return p
  })
  service.approve(authorize(service).id)
  const p = repo.getProject()
  assert.equal(revealDecision(p, planOf(p, 2), fsOf(p)).reason, 'wrong-chapter')
  assert.throws(() => buildWriterPacket(p, 2), /wrong-chapter/)
})

test('授权不能绕过「已真实铺设」：没有任何 plant 事件时仍 not-planted', t => {
  const { repo, service } = fixture(t, p => { p.ledger.foreshadowEvents = []; return p })
  service.approve(authorize(service).id)
  const p = repo.getProject()
  assert.equal(revealDecision(p, planOf(p, 3), fsOf(p)).reason, 'not-planted')
})

test('关联仍待审核的伏笔不允许授权回收', t => {
  const { service } = fixture(t, p => { p.outline.foreshadows[0].linkStatus = 'needsReview'; return p })
  assert.throws(() => authorize(service), /关联仍待审核/)
})

test('还没有确定回收章的伏笔不允许授权', t => {
  const { service } = fixture(t, p => {
    p.outline.foreshadows[0].payoffChapter = null
    p.outline.foreshadows[0].revealAt = null
    return p
  })
  assert.throws(() => authorize(service), /还没有确定的回收章/)
})

test('客户端提交的 approved / reviewedBy 一律被忽略（只有服务端能设定）', t => {
  const { repo, service } = fixture(t)
  const r = service.create('p_test', {
    kind: 'foreshadow', foreshadowId: 'fs_a', field: 'safeReveal', value: '安全版本',
    approved: false, reviewedBy: 'attacker', reviewedAt: '1970-01-01T00:00:00.000Z',
  })
  service.approve(r.id)
  const sr = fsOf(repo.getProject()).safeReveal
  assert.equal(sr.approved, true)
  assert.equal(sr.reviewedBy, 'owner')
  assert.notEqual(sr.reviewedAt, '1970-01-01T00:00:00.000Z')
})

test('回收披露文本有长度上限', t => {
  const { service } = fixture(t)
  assert.throws(() => authorize(service, '字'.repeat(1201)), /不得超过 1200 字/)
})

/* ---------------- 产品行为：授权不该冻结作品 ---------------- */

test('授权不置 pendingReplan（有未来章节也不冻结），而普通伏笔改动照旧冻结', t => {
  const { repo, service } = fixture(t) // 第 2、3 章都还没定稿
  const r = authorize(service)
  assert.equal(r.impact.risk, 'high')
  assert.equal(r.impact.replan, false, '授权不改变任何章节计划 ⇒ 不该要求重排')
  assert.deepEqual(r.impact.affectedChapters, [3], '只影响该伏笔声明的回收章')
  const p = service.approve(r.id).project
  assert.equal(p.pendingReplan, undefined, '授权后仍然可以继续写正文')
  assert.doesNotThrow(() => buildWriterPacket(repo.getProject(), 3))

  // 对照：改回收真相仍然置 pendingReplan（判据没有被放宽过头）
  const r2 = service.create('p_test', { kind: 'foreshadow', foreshadowId: 'fs_a', field: 'payoff', value: '换一个真相' })
  assert.equal(r2.impact.replan, true)
  service.approve(r2.id)
  assert.equal(repo.getProject().pendingReplan, true)
})

test('改回收真相会作废已给出的授权（必须重新授权）', t => {
  const { repo, service } = fixture(t)
  service.approve(authorize(service).id)
  assert.equal(fsOf(repo.getProject()).safeReveal.approved, true)
  service.approve(service.create('p_test', { kind: 'foreshadow', foreshadowId: 'fs_a', field: 'payoff', value: '换成另一个真相' }).id)
  const p = repo.getProject()
  assert.equal(fsOf(p).safeReveal, null)
  assert.equal(revealDecision(p, planOf(p, 3), fsOf(p)).reason, 'not-approved')
})

test('授权走既有的 ChangeRequest 审计：CAS 版本递增、editEvents 记录、旧请求失效', t => {
  const { repo, service } = fixture(t)
  const r = authorize(service)
  const stale = authorize(service) // 与 r 同一基线
  const p = service.approve(r.id).project
  assert.equal(p.editRevision, 1)
  assert.equal(p.editEvents.at(-1).id, r.id)
  assert.equal(p.editEvents.at(-1).kind, 'foreshadow')
  assert.equal(p.editEvents.at(-1).impact.replanSkipped, false, '授权不是「本可重排但没有未来章节」，而是根本不需要重排')
  assert.throws(() => service.approve(stale.id), /已变化/)
  assert.equal(service.get(stale.id).status, 'stale')
})
