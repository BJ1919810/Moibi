import test from 'node:test'
import assert from 'node:assert/strict'
import { findLeaks } from '../server/projection.js'

/**
 * 泄漏门禁的**「文本已公开」豁免**。
 *
 * ⛔ 实测（2026-10-14 全流程首跑《三秒之后》）：第 3 章投影被拦死，3 条 entity-secret 全是误报，
 *    片段在正文里**逐字都不存在** —— 它们来自**记忆抽取的转述**，而转述恰好与作者侧秘密的措辞重合：
 *      正文：「你能看见几秒之后的事」／账本：`林晚｜知道：陈默自称能看见几秒后的事`
 *      秘密：「她半年前…见过一个…醒来声称能看见几秒后画面的老人」
 *    秘密的**主张**并不在 packet 里；拿「故事已经讲过的事」当泄漏拦下一章 ⇒ **这本书从此写不下去**。
 *
 * 这道豁免**只覆盖「文本已公开」**，绝不放宽真正的泄漏面（见下面两条「仍要拦」）。
 */

const SECRET_PHRASE = '能看见几秒后画面的老人'

const makeProject = ({ text = '', knowledge = [] } = {}) => ({
  id: 'p_leak2',
  entities: [{ id: 'ent_a', kind: 'character', name: '林晚', aliases: [], secret: `她半年前也见过一个${SECRET_PHRASE}，老人后来失踪了` }],
  chapters: text ? [{ no: 1, status: 'committed', text, summary: 's' }] : [],
  ledger: { currentState: [], characterKnowledge: knowledge, plotThreads: [], canonicalFacts: [] },
  outline: { foreshadows: [], volumes: [] },
})

const packetWith = ({ summary = '', context = {} } = {}) => ({
  task: { no: 2, summary, foreshadows: [], authorizedReveals: [] }, cast: [], context, work: {},
})

test('豁免①：秘密的措辞已经出现在**已定稿正文**里 ⇒ 不算泄漏（拦住它也不能让故事退回去）', () => {
  const p = makeProject({ text: '病房里林晚忽然说：「我以前也见过一个能看见几秒后画面的老人。」' })
  const issues = findLeaks(packetWith({ context: { prevTail: '……能看见几秒后画面的老人。' } }), p)
  assert.deepEqual(issues, [], JSON.stringify(issues))
})

test('豁免②：措辞出现在**带出处（sourceChapter）的账本条目**里 ⇒ 那是从正文抽出来的，不是泄漏', () => {
  const p = makeProject({
    knowledge: [{ id: 'kn_1', characterId: 'ent_a', belief: 'knows', fact: '她见过一个能看见几秒后画面的老人', sourceChapter: 1, trust: 'canonical' }],
  })
  const issues = findLeaks(packetWith({ context: { knowledge: ['林晚｜知道：她见过一个能看见几秒后画面的老人'] } }), p)
  assert.deepEqual(issues, [], JSON.stringify(issues))
})

test('⛔ 仍要拦：片段只出现在 `task.summary` 里（作者侧真相被搬进给正文看的提示词）', () => {
  const p = makeProject({ text: '这一章正文完全没提那件事。' })
  const issues = findLeaks(packetWith({ summary: '让主角揭穿她见过能看见几秒后画面的老人这件事' }), p)
  assert.ok(issues.some((i) => i.type === 'entity-secret'), `必须拦住这个真泄漏：${JSON.stringify(issues)}`)
})

test('⛔ 仍要拦：账本条目**没有出处**（抽取幻觉、来源不明）不能当作「已公开」', () => {
  const p = makeProject({
    knowledge: [{ id: 'kn_2', characterId: 'ent_a', belief: 'knows', fact: '她见过一个能看见几秒后画面的老人' }], // 无 sourceChapter
  })
  const issues = findLeaks(packetWith({ context: { knowledge: ['林晚｜知道：她见过一个能看见几秒后画面的老人'] } }), p)
  assert.ok(issues.some((i) => i.type === 'entity-secret'), `没有出处就必须拦：${JSON.stringify(issues)}`)
})

test('回归：作者已授权的披露（readerKnown）照旧豁免', () => {
  const p = makeProject({})
  const issues = findLeaks(packetWith({ context: { readerKnown: ['她见过一个能看见几秒后画面的老人'] } }), p)
  assert.deepEqual(issues, [], JSON.stringify(issues))
})
