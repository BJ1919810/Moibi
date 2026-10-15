import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanBody, stripFence } from '../server/schema.js'

/**
 * 正文清洗必须**在活路径上**，而且**只有一份**。
 *
 * ⛔ 病灶：`cleanBody` 原来只被 `pipeline.generateChapter()` 调用，而那个函数**没有活调用者**；
 *    活路径 `workflow.js` 提交的是模型原文，只做了 `stripFence` ⇒
 *    模型爱加的开头（「第一章 格口十二」「以下是正文：」「---」）会**落进正式正文**，
 *    而正式正文永不自动改写 ⇒ 读者直接看到。
 *    「清洗逻辑挂在死路径、活路径没有」是本项目栽过多次的同一个形状。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('cleanBody：剥掉模型爱加的三类开头噪声，且只动开头', () => {
  const prose = '陈默把工牌摘下来攥在手里。\n\n雪比刚才大了些。'
  assert.equal(cleanBody(`# 第一章 格口十二\n\n${prose}`), prose)
  assert.equal(cleanBody(`第一章 格口十二\n\n${prose}`), prose)
  assert.equal(cleanBody(`## 第 12 章 收束\n${prose}`), prose)
  assert.equal(cleanBody(`以下是正文：\n${prose}`), prose)
  assert.equal(cleanBody(`正文：\n\n${prose}`), prose)
  assert.equal(cleanBody(`---\n${prose}`), prose)
  assert.equal(cleanBody('```\n' + prose + '\n```'), prose, '围栏也要剥（stripFence 的职责）')
})

test('cleanBody：⛔ 绝不动正文内容（不改写、不截断、不删段中出现的同类字样）', () => {
  const mid = '他在心里念了一遍「第一章」，觉得自己有点可笑。'
  assert.equal(cleanBody(mid), mid, '出现在**段中**的「第一章」不能被当成标题删掉')
  const long = '第一段。\n\n第二段。\n\n第三段。'
  assert.equal(cleanBody(long), long, '内容一字不动')
  assert.equal(cleanBody('  前后空白  '), '前后空白', '只 trim 两端')
  assert.equal(cleanBody(''), '')
})

test('cleanBody 幂等（第二次不再变化）', () => {
  const once = cleanBody('# 第一章 开端\n\n正文开始。')
  assert.equal(cleanBody(once), once)
})

test('stripFence：JSON 代码围栏也要剥，且对普通文本无害', () => {
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripFence('```\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripFence('{"a":1}'), '{"a":1}')
  assert.equal(stripFence(''), '')
})

test('⛔ 接线：活路径必须用 cleanBody；两份内联实现必须消失', () => {
  const wf = read('server/workflow.js')
  assert.match(wf, /text: cleanBody\(response\.text\)/, '活路径没有清正文 ⇒ 模型的开头噪声会进正式正文')
  assert.doesNotMatch(wf, /const stripFence =/, 'workflow 里不许再留内联的 stripFence（已收进 schema.js）')
  const schema = read('server/schema.js')
  assert.match(schema, /export function cleanBody\(/)
  assert.match(schema, /export function stripFence\(/)
})

test('⛔ 第二条正文出口已经**整段删除**，且不许以任何形式复活', () => {
  // 2026-10-14：`pipeline.generateChapter`（120+ 行）连同只被它用到的 `countWords` 一起删除。
  // 这条断言比「不许有调用者」更强：**连定义都不许有**。
  assert.doesNotMatch(read('server/pipeline.js'), /export\s+async\s+function\s+generateChapter/,
    '那条死出口又回来了 —— 正文生成只有 workflow 一条路')
  assert.doesNotMatch(read('server/pipeline.js'), /function\s+countWords/,
    'countWords 是那条死出口的私用辅助函数，不该单独存在')

  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'dist-web-verify', 'data', 'outputs', 'android', 'docs'].includes(e.name)) continue
        walk(p); continue
      }
      if (!/\.(js|jsx|mjs)$/.test(e.name)) continue
      if (p.includes(`${path.sep}tests${path.sep}`)) continue
      const text = fs.readFileSync(p, 'utf8')
      // ⚠️ 必须先**剥注释**再扫：本项目多处注释都在讲这条死出口的教训，
      //    扫注释会把「解释病」当成「还在犯病」（这个坑我踩了两次）。
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      for (const m of code.matchAll(/generateChapter\s*\(/g)) {
        const line = code.slice(0, m.index).split('\n').length
        offenders.push(`${path.relative(ROOT, p)}:${line}  ${(code.split('\n')[line - 1] || '').trim().slice(0, 80)}`)
      }
    }
  }
  walk(path.join(ROOT, 'server'))
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(offenders, [],
    `正文生成只允许一条路径（workflow）。这些地方又调用了那条已删除的出口：\n${offenders.join('\n')}`)
})
