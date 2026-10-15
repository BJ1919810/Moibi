import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUNNING_RUN_STATUSES, BLOCKING_RUN_STATUSES, ATTENTION_RUN_STATUSES, TERMINAL_RUN_STATUSES,
  isRunningRun, isBlockingRun, isAttentionRun, findBlockingRun,
} from '../server/run-status.js'

/**
 * run 状态词汇的**唯一来源**。
 *
 * 背景：这套词原来在四个地方各写了一份（workflow / replan / Write.jsx 的 ACTIVE /
 * Write.jsx 的一个内联数组）。逐条核对后发现它们回答的是**三个不同的问题**，
 * 只是都被叫成了 `ACTIVE`/`BLOCKING` —— **同名才是病**。
 * 这个测试锁两件事：① 三个集合的语义边界；② 谁都不许再抄第四份。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

test('三个集合的语义边界（差别就在两个「机器停了但在等人」的状态上）', () => {
  // needs_input：「该重新起一次」⇒ 不该挡住起新任务，但界面必须能接手显示
  assert.ok(!BLOCKING_RUN_STATUSES.includes('needs_input'), 'needs_input 不该挡住新任务（createRun 会接管同一个 run）')
  assert.ok(ATTENTION_RUN_STATUSES.includes('needs_input'), 'needs_input 必须能被界面接手，否则用户回不到「继续」入口')
  // awaiting_acceptance：机器停了但握着已付费草稿 ⇒ 两个都算
  assert.ok(BLOCKING_RUN_STATUSES.includes('awaiting_acceptance'))
  assert.ok(ATTENTION_RUN_STATUSES.includes('awaiting_acceptance'))
  // 正在跑的：三个都在
  for (const s of RUNNING_RUN_STATUSES) {
    assert.ok(BLOCKING_RUN_STATUSES.includes(s) && ATTENTION_RUN_STATUSES.includes(s), s)
  }
  // 终态：一个都不在
  for (const s of TERMINAL_RUN_STATUSES) {
    assert.ok(!ATTENTION_RUN_STATUSES.includes(s), `${s} 是终态，不该被当成要接手的任务`)
  }
  // 集合关系：RUNNING ⊂ BLOCKING ⊂ ATTENTION
  assert.equal(BLOCKING_RUN_STATUSES.length, RUNNING_RUN_STATUSES.length + 1)
  assert.equal(ATTENTION_RUN_STATUSES.length, BLOCKING_RUN_STATUSES.length + 1)
})

test('判定函数与 findBlockingRun（并发互斥的唯一判据）', () => {
  assert.equal(isRunningRun({ status: 'writing' }), true)
  assert.equal(isRunningRun({ status: 'awaiting_acceptance' }), false, '等人在确认 ⇒ 不该继续轮询')
  assert.equal(isBlockingRun({ status: 'awaiting_acceptance' }), true)
  assert.equal(isBlockingRun({ status: 'needs_input' }), false)
  assert.equal(isAttentionRun({ status: 'needs_input' }), true)
  assert.equal(isAttentionRun({ status: 'committed' }), false)

  const runs = [{ status: 'committed' }, { status: 'needs_input' }, { status: 'writing' }]
  assert.equal(findBlockingRun(runs)?.status, 'writing')
  assert.equal(findBlockingRun([{ status: 'needs_input' }]), null, 'needs_input 不占用作品')
  assert.equal(findBlockingRun([]), null)
  assert.equal(findBlockingRun(null), null)
})

test('⛔ 防复发：server/ 与 src/ 里不许再出现「状态字面量列表」（判据副本扫描）', () => {
  const STATUSES = 'queued|planning|writing|extracting|reviewing|awaiting_acceptance|needs_input'
  // 形如 'writing', 'extracting', 'reviewing' —— 三个以上状态字面量的逗号列表
  const LIST = new RegExp(`'(?:${STATUSES})'(?:\\s*,\\s*'(?:${STATUSES})'){2,}`)
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'dist-web-verify', 'data', 'outputs', 'android', 'docs'].includes(e.name)) continue
        walk(p); continue
      }
      if (!/\.(js|jsx|mjs)$/.test(e.name)) continue
      // 唯一来源自身、以及测试目录（测试本来就要写这些字面量）除外
      if (p.endsWith(path.join('server', 'run-status.js'))) continue
      if (p.includes(`${path.sep}tests${path.sep}`)) continue
      const text = fs.readFileSync(p, 'utf8')
      if (LIST.test(text)) offenders.push(path.relative(ROOT, p))
    }
  }
  walk(path.join(ROOT, 'server'))
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(offenders, [],
    `这些文件又抄了一份 run 状态列表，请改为从 server/run-status.js 引入并**按问题选集合**：\n${offenders.join('\n')}`)
})
