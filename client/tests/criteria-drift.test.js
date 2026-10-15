import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeForeshadowAction } from '../server/schema.js'
import { updateAuthorSettings } from '../server/author-control.js'
import { hasFutureChaptersToReplan } from '../server/change-impact.js'
import { allowedForeshadowActions } from '../server/foreshadow.js'
import { extractMessages } from '../server/prompts.js'
import { buildWriterPacket } from '../server/projection.js'
import { emptyLedger } from '../server/schema.js'

/**
 * 判据漂移的回归锁（2026-10-13 三路审计的产物）。
 *
 * 这个项目的病根不是「某个函数写错了」，而是**同一条规则在多个地方各写一遍**：
 * v1 逆向 → workbuddy 重构 → ChatGPT 云端大改 → 我接手，四次换手，每一手都在旧规则旁边
 * 又抄一份，于是「改了一处、漏了另一处」反复发生。本文件把已经收敛到唯一实现的判据钉住，
 * 防止下次交接又抄出第二份。
 */

const project = (over = {}) => ({
  id: 'p_drift', headVersion: 1, editRevision: 1, targetChapters: 3,
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [] }],
  chapters: [{ no: 1, status: 'committed', text: '赵甲在门外等候。', summary: '开端' }],
  outline: {
    totalChapters: 3, plannedDetailThrough: 1, foreshadows: [],
    volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '开端', summary: '开端', cast: ['ent_a'] },
      { no: 2, title: '继续', summary: '继续', cast: ['ent_a'], pendingDetail: true },
      { no: 3, title: '收束', summary: '收束', cast: ['ent_a'], pendingDetail: true },
    ] }],
  },
  ledger: emptyLedger(),
  ...over,
})

/* ---------- ① 伏笔动作归一：开书路径与重排路径必须同一份映射 ---------- */

test('伏笔动作归一：中文与同义词都映射到合法取值（唯一实现，两条路径共用）', () => {
  for (const [raw, want] of [
    ['埋设', 'plant'], ['铺设', 'plant'], ['埋下', 'plant'], ['plant', 'plant'],
    ['强化', 'reinforce'], ['reinforce', 'reinforce'],
    ['回收', 'pay_off'], ['揭晓', 'pay_off'], ['payoff', 'pay_off'], ['PAY_OFF', 'pay_off'], ['pay-off', 'pay_off'],
  ]) assert.equal(normalizeForeshadowAction(raw), want, `${raw} → ${want}`)
  // 认不出来的一律返回 null，由调用方丢弃并记 warning —— 绝不放行原串
  assert.equal(normalizeForeshadowAction('忽然'), null)
  assert.equal(normalizeForeshadowAction(''), null)
  assert.equal(normalizeForeshadowAction(undefined), null)
})

test('归一后的动作能通过消费端白名单（这一环断了就会「某章永久写不出来」）', () => {
  // 模拟开书路径把模型写的「埋设」归一后落盘
  const action = normalizeForeshadowAction('埋设')
  const p = project()
  p.outline.foreshadows = [{ id: 'f1', seed: '一封信', payoff: '信是老师写的', plantChapter: 1, payoffChapter: 3, linkStatus: 'explicit' }]
  p.outline.volumes[0].chapters[0].foreshadows = [{ id: 'f1', action, approved: true }]
  const packet = buildWriterPacket(p, 1)
  assert.deepEqual((packet.task.foreshadows || []).map((x) => `${x.id}:${x.action}`), ['f1:plant'],
    '归一成 plant 之后必须真的进得了正文任务；若消费端仍丢弃，回收章就会 not-planted')
})

/* ---------- ② pendingReplan 的边界：没有未来章节就不许冻结作品 ---------- */

test('没有未来章节要重排时，改目标章数**不得**冻结作品（同形死锁的回归锁）', () => {
  // 开书失败留下的空壳：没有大纲 ⇒ 无未来章节
  const empty = project({ outline: null, chapters: [] })
  assert.equal(hasFutureChaptersToReplan(empty), false)
  const after = updateAuthorSettings(empty, { targetChapters: 40 }, 1)
  assert.equal(after.targetChapters, 40)
  assert.equal(after.pendingReplan, undefined, '否则正文被拦、重排又没章节可排 ⇒ 两头堵死')

  // 全书已定稿：同样没有未来章节
  const done = project({
    targetChapters: 3, editRevision: 1,
    chapters: [1, 2, 3].map((no) => ({ no, status: 'committed', text: 'x', summary: 's' })),
  })
  // 已定稿的章不能再改小目标（validateChapterCount 会挡），所以往上加
  const after2 = updateAuthorSettings(done, { targetChapters: 5 }, 1)
  assert.equal(after2.pendingReplan, undefined)
  assert.equal(hasFutureChaptersToReplan(done), false)
})

test('仍有未来章节时，改目标章数照旧冻结作品（判据没有被放宽过头）', () => {
  const p = project() // 第 2、3 章是 pendingDetail，尚未定稿
  assert.equal(hasFutureChaptersToReplan(p), true)
  const after = updateAuthorSettings(p, { targetChapters: 5 }, 1)
  assert.equal(after.pendingReplan, true)
})

/* ---------- ③ 回收授权：抽取允许清单与提示词必须口径一致 ---------- */

const fsProject = () => {
  const p = project()
  p.outline.foreshadows = [{ id: 'f1', seed: '一封信', payoff: '信是老师写的', plantChapter: 1, payoffChapter: 3, linkStatus: 'explicit', safeReveal: { text: '信是老师留下的', approved: true, reviewedBy: 'owner' } }]
  p.outline.volumes[0].chapters[2].foreshadows = [{ id: 'f1', action: 'pay_off', approved: false }]
  return p
}

test('作者授权回收后，抽取允许清单里必须出现 pay_off（否则回收事件永远不入账）', () => {
  const p = fsProject()
  assert.deepEqual(allowedForeshadowActions(p, 3), [{ id: 'f1', action: 'pay_off' }])
  // 未授权时不给 pay_off（模型无权自我批准）
  const bare = fsProject()
  bare.outline.foreshadows[0].safeReveal = null
  assert.deepEqual(allowedForeshadowActions(bare, 3), [])
})

test('提示词口径必须跟着允许清单走：授权了就不再写「不要输出 pay_off」', () => {
  const catalog = [{ id: 'f1', seed: '一封信', plantChapter: 1, payoffChapter: 3 }]
  const allowedPrompt = extractMessages('正文', 3, { foreshadows: catalog, plannedActions: [{ id: 'f1', action: 'pay_off' }] })
    .map((m) => m.content).join('\n')
  assert.match(allowedPrompt, /已经由作者授权/)
  assert.doesNotMatch(allowedPrompt, /不要输出 pay_off/)

  const blockedPrompt = extractMessages('正文', 3, { foreshadows: catalog, plannedActions: [{ id: 'f1', action: 'reinforce' }] })
    .map((m) => m.content).join('\n')
  assert.match(blockedPrompt, /不要输出 pay_off/)
})

/* ---------- ④ 证据门槛统一：中文短证据不再被「原始长度」误杀 ---------- */

test('证据门槛统一：三个字符但逐字在正文里的证据必须被接受（曾被 length<4 误杀）', async () => {
  const { recordForeshadowEvidence } = await import('../server/foreshadow.js')
  const withPlan = () => {
    const p = project()
    p.outline.foreshadows = [{ id: 'f1', seed: '一封信', payoff: '信是老师写的',
      plantChapter: 1, payoffChapter: 3, linkStatus: 'explicit', prerequisiteEventIds: [] }]
    p.outline.volumes[0].chapters[1].foreshadows = [{ id: 'f1', action: 'plant', approved: true }]
    return p
  }
  const chapter = { no: 2, status: 'committed', text: '“不是。”遥说。' }

  // `不是。` 只有 3 个字符，但它是正文里逐字存在的一句话 —— 有效的铺设证据。
  // 旧判据 `evidence.length < 4` 会直接拒掉它 ⇒ 账本没有 plant 事件 ⇒ 回收章 not-planted ⇒ 整章写不出来。
  const ok = recordForeshadowEvidence(withPlan(), chapter, [{ foreshadowId: 'f1', action: 'plant', evidence: '不是。' }])
  assert.equal(ok.accepted.length, 1, `应接受，实际 rejected=${JSON.stringify(ok.rejected)}`)

  // 对照：门槛降到「实义字 ≥2」，但**不是不设门槛** —— 没有实义内容的碎片仍要拒。
  const bad = recordForeshadowEvidence(withPlan(), chapter, [{ foreshadowId: 'f1', action: 'plant', evidence: '……' }])
  assert.equal(bad.accepted.length, 0)
  assert.equal(bad.rejected[0].reason, 'missing-plan-or-evidence')
})

/* ---------- ⑤ 助手白名单与作者侧同源：改文风必须真的生效 ---------- */

test('助手改文风必须真的改变正文提示词（过去写的是被屏蔽的 style，静默无效）', async () => {
  const { validateAssistantChange, applyAssistantChange } = await import('../server/assistant.js')
  const before = project()
  const text = '第三人称限知；冷峻克制，长短句交错。'
  // 白名单与 author-control 同源 ⇒ `styleSpec` 现在可写
  const change = validateAssistantChange({ kind: 'preferences', values: { styleSpec: text } }, before)
  const after = applyAssistantChange(before, change, before.editRevision)
  assert.equal(after.preferences.styleSpec, text)

  // 真正生效的判据在投影层：`writerStyleBase()` 优先读 styleSpec
  const p1 = buildWriterPacket(before, 1)
  const p2 = buildWriterPacket(after, 1)
  assert.match(p2.style.base, /长短句交错/, '改完文风，正文提示词里的文风段必须真的变了')
  assert.notEqual(p2.style.base, p1.style.base)

  // 越权字段仍然拒绝（只是补齐了漏掉的那一项，白名单没有变宽）
  assert.throws(() => validateAssistantChange({ kind: 'preferences', values: { admin: 'yes' } }, before), /不允许/)
})
