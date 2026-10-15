import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAPTER_RISK, prepareChapterPlan } from '../server/chapter-planner.js'
import { IMPACT_RISK, analyzeChange } from '../server/change-impact.js'
import { emptyLedger } from '../server/schema.js'

/**
 * 两个 `risk` 同名不同义 —— 现在各有名字，且**取值集合互不相交**。
 *
 * 背景：`change-impact.js` 的 `risk`（`low|medium|high`）判「作者改动会不会波及未来计划」；
 * `chapter-planner.js` 的 `risk`（`normal|high`）判「这一章有没有秘密披露/要回收伏笔」。
 * 两边都用了字面量 `'high'`，读代码的人分不清，复制粘贴极易串味。
 * 修法：字段改名 `run.plan.chapterRisk`（旧 run 文件兼容读）、两边取值改用命名常量。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const project = () => ({
  id: 'p_risk', headVersion: 0, editRevision: 0, title: 't', targetChapters: 3,
  preferences: {}, chapters: [],
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员' }],
  outline: {
    totalChapters: 3, plannedDetailThrough: 1,
    foreshadows: [{ id: 'f1', seed: '旧信', payoff: '信是老师写的', plantChapter: 1, payoffChapter: 3, linkStatus: 'explicit' }],
    volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '开端', summary: '开端', cast: ['ent_a'] },
      { no: 2, title: '回收章', summary: '回收', cast: ['ent_a'],
        foreshadows: [{ id: 'f1', action: 'pay_off', approved: true }],
        reveals: [{ entityId: 'ent_a', projectionId: 'rp_x', approved: true, notBeforeChapter: 2 }] },
      { no: 3, title: '收束', summary: '收束', cast: ['ent_a'] },
    ] }],
  },
  ledger: emptyLedger(),
})

test('两套词表的取值集合**互不相交**（各自只在自己的语义里出现）', () => {
  const chapterVals = new Set(Object.values(CHAPTER_RISK))
  const impactVals = new Set(Object.values(IMPACT_RISK))
  assert.deepEqual([...chapterVals].sort(), ['high', 'normal'])
  assert.deepEqual([...impactVals].sort(), ['high', 'low', 'medium'])
  // 唯一的交集是 'high'（两边都表示「要注意」）—— 其余必须各自独立，
  // 这样 `impact.risk === 'normal'` 或 `chapterRisk === 'low'` 永远是写错了
  const shared = [...chapterVals].filter((v) => impactVals.has(v))
  assert.deepEqual(shared, ['high'], '除 high 外不该有共同取值')
})

test('章节计划返回的是 `chapterRisk`（不再是歧义的 `risk`）', () => {
  const plan = prepareChapterPlan(project(), 2)
  assert.equal(plan.chapterRisk, CHAPTER_RISK.HIGH, '有回收 + 披露 ⇒ high')
  assert.ok(!('risk' in plan), '不许再返回裸 `risk`（那会与 impact.risk 同名）')
  const plain = prepareChapterPlan(project(), 1)
  assert.equal(plain.chapterRisk, CHAPTER_RISK.NORMAL)
})

test('作者改动的影响风险仍是三级（不受改名影响）', () => {
  const p = project()
  assert.equal(analyzeChange(p, { kind: 'preferences', field: 'styleSpec', value: 'x' }).risk, IMPACT_RISK.LOW)
  assert.equal(analyzeChange(p, { kind: 'world', value: 'x' }).risk, IMPACT_RISK.HIGH)
})

test('⛔ 防复发：读 `plan.risk` 的地方必须带 `chapterRisk` 兼容读（否则静默退化成默认值）', () => {
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'data', 'outputs', 'android', 'docs'].includes(e.name)) continue
        walk(p); continue
      }
      if (!/\.(js|mjs|jsx)$/.test(e.name)) continue
      if (p.includes(`${path.sep}tests${path.sep}`)) continue
      const text = fs.readFileSync(p, 'utf8')
      // 只读 plan.risk、不提 chapterRisk ⇒ 改名后必然静默拿到 undefined/默认值
      if (/plan\??\.risk/.test(text) && !/chapterRisk/.test(text)) offenders.push(path.relative(ROOT, p))
    }
  }
  walk(path.join(ROOT, 'server'))
  walk(path.join(ROOT, 'scripts'))
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(offenders, [], `这些地方读 plan.risk 却没带 chapterRisk 兼容读：\n${offenders.join('\n')}`)
})
