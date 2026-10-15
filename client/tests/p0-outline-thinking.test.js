import test from 'node:test'
import assert from 'node:assert/strict'
import { outlineThinkingParams } from '../server/pipeline.js'

/**
 * P0 回归：大纲调用的思考策略必须**跟随设置页开关**，不得再硬编码。
 *
 * 背景（BUG 报告）：generateOutline() 曾硬编码 `thinking: true`，而 deepseek-flash
 * 默认自带思考，导致输出预算被 reasoning 耗尽、正文为空、大纲失败、后续章节全挂。
 * 修复后大纲与正文/提取/助手遵守同一条「思考跟随配置」的约定。
 */

test('P0 大纲思考默认关闭（配置缺省时）', () => {
  assert.equal(outlineThinkingParams({}).thinking, false)
  assert.equal(outlineThinkingParams().thinking, false)
})

test('P0 设置关闭时：不请求思考，预算保持 8192', () => {
  const p = outlineThinkingParams({ thinking: false })
  assert.equal(p.thinking, false)
  assert.equal(p.maxTokens, 8192)
})

test('P0 设置开启时：请求思考，并为 reasoning 额外预留输出预算', () => {
  const p = outlineThinkingParams({ thinking: true })
  assert.equal(p.thinking, true)
  assert.ok(
    p.maxTokens >= 20480,
    '开启思考时预算必须显著高于关闭态，否则正文会被 reasoning 挤空'
  )
})

test('P0 只有严格 true 才开启思考（防止字符串/真值误判）', () => {
  for (const v of [1, 'true', 'yes', {}, [], null, undefined, 0, '']) {
    assert.equal(outlineThinkingParams({ thinking: v }).thinking, false, `thinking=${JSON.stringify(v)} 不应开启`)
  }
})
