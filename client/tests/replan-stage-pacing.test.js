import test from 'node:test'
import assert from 'node:assert/strict'
import { replanMessages } from '../server/replan.js'

/**
 * 滚动 L2 重排的「全书位置 → 阶段要求」。
 *
 * 背景：L1 全书规划**明确**写了总章数并把「三幕要概括全书走向」写成要求，
 * 但这一层只把 `targetChapters` 塞进 JSON 当机器字段，**从没把位置翻译成节奏要求**
 * ⇒ 规划模型不知道自己还剩多少空间，本能地**把手头的料尽早用掉**
 *（该埋的提前揭 ⇒ 真相措辞渗进 writerSummary ⇒ 概要审查报警）。
 */

const p = (target) => ({
  idea: '测试用', genre: '悬疑', targetChapters: target, preferences: {},
  entities: [], chapters: [], outline: { foreshadows: [] },
})
/** 取 user 那一侧的提示词（system 是固定的） */
const user = (from, count, target) => replanMessages(p(target), from, count, [])[1].content

test('开篇（前 25%）：只埋不收，且给出位置百分比', () => {
  const t = user(1, 5, 30)
  assert.match(t, /【全书位置与阶段】/)
  assert.match(t, /约占全书的 0%–17%/, t.slice(t.indexOf('【全书位置'), t.indexOf('【全书位置') + 120))
  assert.match(t, /属于\*\*开篇\*\*/)
  assert.match(t, /只埋不收/)
  assert.match(t, /不要回收任何伏笔/)
})

test('中段：允许回收「已到期」的线，但仍不得提前揭晓真相', () => {
  const t = user(12, 5, 30)
  assert.match(t, /约占全书的 37%–53%/)
  assert.match(t, /属于\*\*中段\*\*/)
  assert.match(t, /已经到期/)
  assert.match(t, /不要提前揭晓任何真相/)
  assert.doesNotMatch(t, /只埋不收/)
})

test('末段（>80% 起）：开始收线、不再新埋长线', () => {
  const t = user(26, 5, 30)
  assert.match(t, /约占全书的 83%–100%/)
  assert.match(t, /属于\*\*末段\*\*/)
  assert.match(t, /开始收线/)
  assert.match(t, /不要再新埋/)
  assert.doesNotMatch(t, /只埋不收/)
})

test('总章数未知时不硬编位置（宁可不说，也不说错）', () => {
  const t = user(2, 3, null)
  assert.doesNotMatch(t, /【全书位置与阶段】/)
  // 但硬约束与清单必须照旧在
  assert.match(t, /【可用的角色 ID/)
  assert.match(t, /【⛔ 伏笔回收章是硬约束/)
})

test('阶段提示与「回收章硬约束」互补：两者都在，且各自说清自己的角色', () => {
  const t = user(12, 5, 30)
  assert.match(t, /【全书位置与阶段】/, '软提示：该埋还是该收')
  assert.match(t, /【⛔ 伏笔回收章是硬约束/, '客观门禁：能不能收')
  assert.match(t, /只能\*\*用 plant \/ reinforce/)
})
