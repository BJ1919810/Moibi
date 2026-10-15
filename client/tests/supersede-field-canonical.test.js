import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { supersedeState } from '../server/ledger.js'
import { emptyLedger, makeState } from '../server/schema.js'

/**
 * 状态失效的边界字段**只有一个名字**：`untilChapter`。
 *
 * ⛔ 现场：`ledger.supersedeState` 原来写 `supersededAtChapter` —— 一个**只写不读**的野字段。
 *    真正被读的是 `untilChapter`（`state-engine` 判「第 N 章的有效状态」按它算）。
 *    ⇒ 用这个函数失效的状态，在时间边界上会被当成**永远有效**。
 *    同一条判据两个键名 ⇒ 改一处、漏一处（本项目的老病）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const projectWith = (rec) => ({ id: 'p_sup', ledger: { ...emptyLedger(), currentState: [rec] } })

test('supersedeState 写的是规范字段 `untilChapter`，并置 status=superseded', () => {
  const rec = { id: 'st_1', subjectId: 'ent_a', attribute: '持有', value: '一把钥匙', status: 'active', sinceChapter: 1 }
  const p = projectWith(rec)
  assert.equal(supersedeState(p, 'st_1', 5), true)
  const s = p.ledger.currentState[0]
  assert.equal(s.status, 'superseded')
  assert.equal(s.untilChapter, 5, '失效边界必须写在被读的那个字段上')
  assert.equal(s.supersededAtChapter, undefined, '野字段不许再出现')
})

test('已失效的记录再失效一次不会把边界改回 null（只前移/保持）', () => {
  const rec = { id: 'st_1', status: 'superseded', sinceChapter: 1, untilChapter: 5 }
  const p = projectWith(rec)
  supersedeState(p, 'st_1')
  assert.equal(p.ledger.currentState[0].untilChapter, 5, '不传章号时不能把已有边界抹掉')
})

test('找不到记录时返回 false，不动账本', () => {
  const p = projectWith({ id: 'st_1', status: 'active' })
  assert.equal(supersedeState(p, 'st_nope', 3), false)
  assert.equal(p.ledger.currentState[0].untilChapter, undefined)
})

test('schema 造出来的状态记录：边界字段是 untilChapter（不是别的名字）', () => {
  const rec = makeState({ subjectId: 'ent_a', attribute: '持有', value: 'v', sinceChapter: 2 })
  assert.ok('untilChapter' in rec, '记录工厂必须产出 untilChapter')
  assert.ok(!('supersededAtChapter' in rec))
})

test('⛔ 防复发：代码里不许再出现 `supersededAtChapter`（源码扫描，注释除外）', () => {
  // ⚠️ 必须**先剥注释**再扫：ledger.js 的文档注释里正当地提到了这个野字段名
  //（那段注释解释了为什么不能再用它）—— 扫注释会把「解释病」当成「还在犯病」。
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
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
      const code = stripComments(fs.readFileSync(p, 'utf8'))
      if (code.includes('supersededAtChapter')) offenders.push(path.relative(ROOT, p))
    }
  }
  walk(path.join(ROOT, 'server'))
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(offenders, [], `这些文件又用了那个只写不读的野字段名：\n${offenders.join('\n')}`)
})

test('⛔ 防复发：失效边界只认 `untilChapter`（state-engine 读的也是它）', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'server/state-engine.js'), 'utf8')
  assert.match(engine, /rec\?\.untilChapter/, 'state-engine 的边界判据应当读 untilChapter')
})
