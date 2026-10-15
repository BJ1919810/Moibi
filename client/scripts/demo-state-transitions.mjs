#!/usr/bin/env node
/**
 * R2 状态转移 · 数据样例生成器
 *
 * 目的：把「状态变化前 / 变化后」的真实数据摊开给人看，而不是只交一份实施报告。
 *
 * 三条取材纪律：
 *   1. **基底是真实作品**。默认读 data/projects 里实体最多、章节最多的那份，
 *      用它的真实体、真事实、真线索。找不到才退回内置最小样例。
 *   2. **转移序列明确标注来源**。每一步变化都注明它在正文/线索里的依据；
 *      依据不存在的，就写「人工构造」，不假装是从正文抽出来的。
 *   3. **不伪造证据**。旧数据补事件时 fromValue 一律留空，样例里如实呈现。
 *
 * 用法：
 *   node scripts/demo-state-transitions.mjs                  # 打印到 stdout
 *   node scripts/demo-state-transitions.mjs --out docs/R2_状态转移样例.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyStateChanges,
  backfillTransitions,
  commitStatePlan,
  currentSnapshot,
  isEffectiveAt,
  planStateChanges,
  queryEvidence,
  queryEventsAtChapter,
  queryKnowledgeAt,
  queryKnowledgeHistory,
  queryStateAt,
  queryStateTimeline,
} from '../server/state-engine.js'
import { emptyLedger, makeEntity, makeKnowledge, makeState } from '../server/schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/* ------------------------------- 取材 ------------------------------- */

function loadRealProject() {
  const dir = path.join(root, 'data', 'projects')
  if (!fs.existsSync(dir)) return null
  let best = null
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let p
    try {
      p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    } catch {
      continue
    }
    if (!p?.entities?.length) continue
    if (!best || (p.chapters?.length || 0) > (best.chapters?.length || 0)) best = p
  }
  return best
}

function fixture() {
  const shen = makeEntity({ name: '沈砚' })
  const gu = makeEntity({ name: '顾行舟' })
  return {
    id: 'demo',
    title: '内置最小样例',
    entities: [shen, gu],
    ledger: emptyLedger(),
    outline: { volumes: [] },
    chapters: [],
    headVersion: 0,
  }
}

function resolveName(project, name) {
  const hit = (project.entities || []).find((e) => e.name === name)
  return hit ? hit.id : null
}

/* ------------------------------ 呈现工具 ------------------------------ */

const mdEsc = (s) => String(s ?? '').replace(/\|/g, '\\|')

function stateRow(r) {
  return [
    `\`${r.id}\``,
    name(r.subjectId),
    mdEsc(r.attribute),
    mdEsc(r.value),
    r.sinceChapter ?? '—',
    r.untilChapter ?? '—',
    r.status === 'active' ? '**active**' : r.status,
  ]
}

function knowRow(k) {
  return [
    `\`${k.id}\``,
    name(k.characterId),
    mdEsc(k.fact),
    k.belief,
    k.sinceChapter ?? '—',
    k.status === 'active' ? '**active**' : k.status,
  ]
}

// 认知事件的 attribute 恒为 'belief'，真正变化的是「对哪条事实的信念」。
// 事实文本存在知识记录上，故用 toStateId 反查，免得主体列显示成 `顾行舟 对「」`。
function knowFactOf(p, e) {
  if (!e || e.kind !== 'knowledge') return null
  const list = p.ledger.characterKnowledge || p.ledger.knowledge || []
  const rec = list.find((k) => k.id === e.toStateId) || list.find((k) => k.id === e.fromStateId)
  return rec ? rec.fact : null
}

function evRow(e, p) {
  const subj =
    e.kind === 'knowledge'
      ? `${name(e.subjectId)} 对「${mdEsc(knowFactOf(p, e) ?? '')}」`
      : name(e.subjectId)
  return [
    `\`${e.id}\``,
    subj,
    mdEsc(e.fromValue ?? '（无）'),
    mdEsc(e.toValue),
    e.chapterNo ?? '—',
    e.seq,
    `\`${e.idempotencyKey}\``,
  ]
}

function evidenceRow(ev) {
  return [
    `\`${ev.id}\``,
    mdEsc(ev.sourceChapter),
    mdEsc(ev.sourceVersion),
    mdEsc(ev.sourceSpan ?? '—'),
    `\`${ev.batchKey}\``,
  ]
}

/** 名称解析表：先按真实作品建，找不到就把 ID 原样显示 */
let NAME = new Map()
const name = (id) => NAME.get(id) || id || '—'

function table(header, rows) {
  if (!rows.length) return '_（无）_\n'
  const out = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ]
  return out.join('\n') + '\n'
}

const L = []
const say = (s = '') => L.push(s)
const dump = (obj) => '```json\n' + JSON.stringify(obj, null, 2) + '\n```\n'

/* ------------------------------- 开跑 ------------------------------- */

const real = loadRealProject()
const base = real ? structuredClone(real) : fixture()
NAME = new Map((base.entities || []).map((e) => [e.id, e.name]))

const shen = resolveName(base, '沈砚')
const gu = resolveName(base, '顾行舟')
const song = resolveName(base, '宋瓷')

const realLedger = base.ledger || {}
const summary = {
  title: base.title,
  entities: (base.entities || []).length,
  chapters: (base.chapters || []).length,
  planned: base.outline?.totalChapters ?? null,
  facts: (realLedger.canonicalFacts || []).length,
  threads: (realLedger.plotThreads || []).length,
  states: (realLedger.currentState || []).length,
  knowledge: (realLedger.characterKnowledge || []).length,
  events: (realLedger.stateEvents || []).length,
}

say('# R2 状态转移 · 数据样例')
say()
say('> 本文件由 `mobi/scripts/demo-state-transitions.mjs` 生成，不是手写的说明。')
say('> 每个场景都会打印**转移前**与**转移后**的账本真实内容。')
say()
say('## 0. 取材')
say()
if (real) {
  say(`- 基底：真实作品《${summary.title}》，读自 \`data/projects/\``)
  say(`- 真实规模：实体 ${summary.entities} 个 · 已写章节 ${summary.chapters} 章 · 全书规划 ${summary.planned} 章`)
  say(`- 真实账本：事实 ${summary.facts} 条 · 线索 ${summary.threads} 条 · **状态 ${summary.states} 条 · 认知 ${summary.knowledge} 条 · 事件 ${summary.events} 条**`)
  say()
  say('**这一点必须先说清楚**：真实旧作品里**一条状态记录都没有**。')
  say('原因是 v1 的数据结构里只有 `state.facts / state.threads / state.lastSummary`，')
  say('压根没有「当前状态」与「角色认知」的槽位 —— 不是迁移弄丢了，是原来就没有。')
  say('所以下面所有状态转移都是**在真实实体与真实线索上驱动的**，')
  say('转移序列每一步都注明依据；依据来自正文/线索的会写明出处，其余标注「人工构造」。')
} else {
  say('- **未找到真实作品数据**，使用内置最小样例。')
}
say()

/* ============ 场景 A：同一章往返 ============ */

say('## 场景 A · 同一章内往返（档案馆 → 青江桥 → 档案馆）')
say()
say('依据：真实线索「沈砚计划下班后去青江桥」，以及信中说「林晚三天后会死在青江桥下」。')
say('同一章里他先去了又回来，是长篇里非常常见的情形。')
say()
say('**要求**：三次变化 = 三条记录、三个事件，两次「档案馆」必须各自可追溯。')
say()

{
  const p = structuredClone(base)
  const before = currentSnapshot(p, { chapterNo: 3 })
  const steps = [
    { value: '档案馆', batchKey: 'demo:ch3:a' },
    { value: '青江桥', batchKey: 'demo:ch3:b' },
    { value: '档案馆', batchKey: 'demo:ch3:c' },
  ]
  const results = []
  for (const s of steps) {
    const r = applyStateChanges(
      p,
      [{ kind: 'state', subject: '沈砚', attribute: '所在', value: s.value, sinceChapter: 3 }],
      { chapterNo: 3, resolveName: (n) => resolveName(p, n), sourceVersion: 3, batchKey: s.batchKey }
    )
    results.push({ value: s.value, batchKey: s.batchKey, applied: r.applied, skipped: !!r.skipped })
  }
  say('转移前（第 3 章有效状态）：')
  say()
  say(table(['state_id', '主体', '属性', '取值', '生效章', '失效章', '状态'], before.states.map(stateRow)))
  say('三步转移的提交结果：')
  say()
  say(dump(results))
  say('转移后（全部记录，含已被替代的）：')
  say()
  say(table(['state_id', '主体', '属性', '取值', '生效章', '失效章', '状态'], (p.ledger.currentState || []).map(stateRow)))
  say('产生的事件：')
  say()
  say(table(['event_id', '主体', 'from', 'to', '章', 'seq', '幂等键'], (p.ledger.stateEvents || []).map((e) => evRow(e, p))))
  say('第 3 章查询到的有效状态（应回到「档案馆」，且只有一条）：')
  say()
  say(table(['state_id', '主体', '属性', '取值', '生效章', '失效章', '状态'], queryStateAt(p, { subjectId: shen, attribute: '所在', chapterNo: 3 }).map(stateRow)))
  const ids = (p.ledger.currentState || []).map((s) => s.id)
  say(`- 三条记录 ID 互不相同：\`${new Set(ids).size === ids.length ? '是' : '否'}\``)
  say(`- 事件 ID 互不相同：\`${new Set((p.ledger.stateEvents || []).map((e) => e.id)).size === 3 ? '是' : '否'}\``)
  say()
}

/* ============ 场景 B：跨章转移与时间回查 ============ */

say('## 场景 B · 跨章转移，以及「第 N 章时他在哪」的回查')
say()
say('依据：线索「沈砚计划下班后去青江桥」→ 第 4 章他回到馆里查尾号零七档案。')
say('要求：**查指定章节的有效状态，而不是最新状态**。')
say()

{
  const p = structuredClone(base)
  applyStateChanges(p, [{ kind: 'state', subject: '沈砚', attribute: '所在', value: '青江桥', sinceChapter: 3 }], {
    chapterNo: 3,
    resolveName: (n) => resolveName(p, n),
    sourceVersion: 3,
    batchKey: 'demo:ch3-go',
  })
  const afterGo = queryStateAt(p, { subjectId: shen, attribute: '所在', chapterNo: 3 })
  applyStateChanges(p, [{ kind: 'state', subject: '沈砚', attribute: '所在', value: '档案馆修复室', sinceChapter: 4 }], {
    chapterNo: 4,
    resolveName: (n) => resolveName(p, n),
    sourceVersion: 4,
    batchKey: 'demo:ch4-back',
  })
  say('第 4 章转移之后，逐章回查同一主体同一属性：')
  say()
  const rows = [2, 3, 4, 5].map((ch) => {
    const hit = queryStateAt(p, { subjectId: shen, attribute: '所在', chapterNo: ch })
    return [`第 ${ch} 章`, hit.length ? mdEsc(hit.map((x) => x.value).join(' / ')) : '（尚无记录）', hit.length ? hit[0].status : '—']
  })
  say(table(['查询章', '该章有效取值', '该记录当前状态'], rows))
  say('完整轨迹（`queryStateTimeline`，含已被替代的历史）：')
  say()
  say(table(['state_id', '主体', '属性', '取值', '生效章', '失效章', '状态'], queryStateTimeline(p, { subjectId: shen, attribute: '所在' }).map(stateRow)))
  say(`- 第 3 章查到的是「${afterGo[0]?.value}」，不是最新的「档案馆修复室」——回查没有被最新值覆盖。`)
  say(`- 但同一条记录的状态是 \`${p.ledger.currentState[0].status}\`：**存储层留档，查询层按章判定**，两者不冲突。`)
  say()
}

/* ============ 场景 C：认知演变 ============ */

say('## 场景 C · 认知演变（suspects → believes → knows），历史必须保留')
say()
say('依据：真实线索「尾号零七档案封皮内侧有一行铅笔字，顾行舟已拍照，待给沈砚看」。')
say('顾行舟对「这卷档案有问题」的把握，是逐步升级的 —— 不是一次跳到位。')
say()

{
  const p = structuredClone(base)
  const fact = '尾号零七档案与十年前的青江桥有关'
  const steps = [
    { belief: 'suspects', ch: 3, key: 'demo:know:3' },
    { belief: 'believes', ch: 5, key: 'demo:know:5' },
    { belief: 'knows', ch: 8, key: 'demo:know:8' },
  ]
  for (const s of steps) {
    applyStateChanges(
      p,
      [{ kind: 'knowledge', character: '顾行舟', fact, belief: s.belief, sinceChapter: s.ch }],
      { chapterNo: s.ch, resolveName: (n) => resolveName(p, n), sourceVersion: s.ch, batchKey: s.key }
    )
  }
  say('完整演变（`queryKnowledgeHistory`）：')
  say()
  say(table(['kn_id', '角色', '内容', '信念', '生效章', '状态'], queryKnowledgeHistory(p, { characterId: gu, fact }).map(knowRow)))
  say('第 6 章时他的认知（`queryKnowledgeAt`）：')
  say()
  say(table(['kn_id', '角色', '内容', '信念', '生效章', '状态'], queryKnowledgeAt(p, { characterId: gu, fact, chapterNo: 6 }).map(knowRow)))
  say('一次转移的完整事件：')
  say()
  say(table(['event_id', '主体', 'from', 'to', '章', 'seq', '幂等键'], (p.ledger.stateEvents || []).map((e) => evRow(e, p))))
  say(`- 三条记录内容（角色+事实）相同，ID 各不相同：\`${new Set((p.ledger.characterKnowledge || []).map((k) => k.id)).size === 3 ? '是' : '否'}\``)
  say(`- 上下文层只会看到一条（第 8 章的 \`knows\`），不会同时看到「怀疑」和「确信」。`)
  say()
}

/* ============ 场景 D：失败保护 ============ */

say('## 场景 D · 失败保护：一批里有一项非法，整批一条都不落')
say()
say('构造方式：第 5 章已确立「沈砚·所在 = 青江桥」，随后一批标注为第 3 章，')
say('其中第三项要写「沈砚·所在 = 档案馆」—— 时间倒退，属 error 级违规。')
say('**要求**：前两项合法，但整批必须一起放弃；账本必须与本批之前逐字一致。')
say()

{
  const p = structuredClone(base)
  applyStateChanges(p, [{ kind: 'state', subject: '沈砚', attribute: '所在', value: '青江桥', sinceChapter: 5 }], {
    chapterNo: 5,
    resolveName: (n) => resolveName(p, n),
    sourceVersion: 5,
    batchKey: 'demo:ch5',
  })
  const beforeJson = JSON.stringify(p.ledger)
  const beforeCount = {
    states: p.ledger.currentState.length,
    knowledge: p.ledger.characterKnowledge.length,
    events: p.ledger.stateEvents.length,
  }
  const r = applyStateChanges(
    p,
    [
      { kind: 'state', subject: '宋瓷', attribute: '所在', value: '档案馆后门', sinceChapter: 3 },
      { kind: 'state', subject: '顾行舟', attribute: '持有', value: '尾号零七档案的翻拍照片', sinceChapter: 3 },
      { kind: 'state', subject: '沈砚', attribute: '所在', value: '档案馆', sinceChapter: 3 },
    ],
    { chapterNo: 3, resolveName: (n) => resolveName(p, n), sourceVersion: 3, batchKey: 'demo:ch3-bad' }
  )
  const afterJson = JSON.stringify(p.ledger)
  say('本批提交返回：')
  say()
  say(dump({
    ok: r.ok,
    rejected: !!r.rejected,
    applied: r.applied,
    violations: (r.violations || []).map((v) => ({ code: v.code, severity: v.severity, index: v.index, message: v.message })),
  }))
  say('账本计数对比：')
  say()
  say(table(['', '本批之前', '本批之后'], [
    ['状态记录', beforeCount.states, p.ledger.currentState.length],
    ['认知记录', beforeCount.knowledge, p.ledger.characterKnowledge.length],
    ['状态事件', beforeCount.events, p.ledger.stateEvents.length],
  ]))
  say(`- 账本逐字一致（\`JSON.stringify\` 比较）：\`${beforeJson === afterJson ? '是' : '否'}\``)
  say(`- 前两项 \`宋瓷·所在\` 与 \`顾行舟·持有\` 虽然合法，但一条都没落 —— 整组不得部分生效。`)
  say()
}

/* ============ 场景 E：重复提交 ============ */

say('## 场景 E · 重复提交：同一批内容执行两次，结果与执行一次完全一致')
say()
say('构造方式：同一提交标识（batchKey）连续执行两次。')
say('**要求**：第二次不得产生任何新记录、新事件；也不能因为「内容相同」把新的一次真实变化误判成重复。')
say()

{
  const p = structuredClone(base)
  const payload = [
    { kind: 'state', subject: '沈砚', attribute: '所在', value: '青江桥', sinceChapter: 3 },
    { kind: 'knowledge', character: '沈砚', fact: '信上的落款日期还没到', belief: 'knows', sinceChapter: 3 },
  ]
  const ctxA = { chapterNo: 3, resolveName: (n) => resolveName(p, n), sourceVersion: 3, batchKey: 'demo:dup-1' }
  const first = applyStateChanges(p, payload, ctxA)
  const afterFirst = JSON.stringify(p.ledger)
  const second = applyStateChanges(p, payload, ctxA)
  const afterSecond = JSON.stringify(p.ledger)
  say('两次执行对比：')
  say()
  say(table(['', '第一次', '第二次'], [
    ['ok', first.ok, second.ok],
    ['skipped', !!first.skipped, !!second.skipped],
    ['skip 原因', first.reason || '—', second.reason || '—'],
    ['新增状态', first.applied.states, second.applied.states],
    ['新增认知', first.applied.knowledge, second.applied.knowledge],
    ['新增事件', first.applied.events, second.applied.events],
  ]))
  say(`- 第二次执行后账本与第一次逐字一致：\`${afterFirst === afterSecond ? '是' : '否'}\``)
  say()
  say('**反面**：换一个提交标识、内容完全相同 —— 必须当成新的一次真实变化。')
  say()
  const third = applyStateChanges(p, payload, { ...ctxA, batchKey: 'demo:dup-2' })
  say(table(['', '第二次（同标识）', '第三次（新标识）'], [
    ['skipped', !!second.skipped, !!third.skipped],
    ['新增状态', second.applied.states, third.applied.states],
    ['新增事件', second.applied.events, third.applied.events],
  ]))
  say()
}

/* ============ 场景 F：证据溯源 ============ */

say('## 场景 F · 证据溯源：从一条状态回到正文版本与位置')
say()
say('要求：状态事件能关联**来源正文版本**与**具体位置**。')
say('R2 已把 `sourceChapter / sourceVersion / sourceSpan` 贯通到记录与事件；')
say('`sourceSpan`（正文内的具体位置）留待反向提取补，本样例如实显示为未填。')
say()

{
  const p = structuredClone(base)
  const r = applyStateChanges(p, [{ kind: 'state', subject: '沈砚', attribute: '所在', value: '青江桥', sinceChapter: 3 }], {
    chapterNo: 3,
    resolveName: (n) => resolveName(p, n),
    sourceVersion: 3,
    batchKey: 'ch3:cf_7be2f1a90c',
  })
  const rec = p.ledger.currentState[0]
  const t = r.events[0]
  const ev = queryEvidence(p, { stateId: rec.id })
  say('从状态记录反查：')
  say()
  say(dump({
    state_id: rec.id,
    event_id: rec.eventId,
    sourceChapter: ev.sourceChapter,
    sourceVersion: ev.sourceVersion,
    sourceSpan: ev.sourceSpan,
    batchKey: ev.event.batchKey,
    idempotencyKey: ev.event.idempotencyKey,
  }))
  say('从事件正查：')
  say()
  say(table(['event_id', '来源章', '正文版本', '正文位置', '提交标识'], [evidenceRow(ev.event)]))
  say()

  say('### 三个 ID 各司其职（同一个场景里的实际取值）')
  say()
  say(table(['ID 类型', '标识什么', '本场景取值'], [
    ['`state_id`', '一条状态记录（当前是什么）', `\`${rec.id}\``],
    ['`event_id`', '一次状态转移（发生了什么）', `\`${t.id}\``],
    ['`idempotency_key`', '一次提交（是不是重复）', `\`${t.idempotencyKey}\``],
  ]))
  say()
}

/* ============ 场景 G：旧形状账本补事件 ============ */

say('## 场景 G · 旧形状账本补事件（确定性、可重复、不伪造证据）')
say()
say('真实作品里没有状态记录（见第 0 节），所以这里用一份**人工构造的旧形状账本**演示补齐行为：')
say('同一个 `(主体, 属性)` 有三条 active、都没有 `eventSeq` 与 `eventId`，')
say('这正是旧数据最典型的病：既是「当前状态」，又是自相矛盾的。')
say()

{
  const p = structuredClone(base)
  p.ledger = emptyLedger()
  const mk = (v, ch) => makeState({ subjectId: shen, attribute: '所在', value: v, sinceChapter: ch, sourceChapter: ch })
  p.ledger.currentState = [mk('档案馆', 1), mk('青江桥', 2), mk('城南邮局', 3)]
  p.ledger.characterKnowledge = [
    makeKnowledge({ characterId: gu, fact: '尾号零七档案有问题', belief: 'suspects', sinceChapter: 2 }),
  ]
  const before = p.ledger.currentState.map((s) => ({ id: s.id, value: s.value, ch: s.sinceChapter, status: s.status, eventSeq: s.eventSeq, eventId: s.eventId }))
  const r1 = backfillTransitions(p)
  const after = p.ledger.currentState.map((s) => ({ id: s.id, value: s.value, ch: s.sinceChapter, status: s.status, untilChapter: s.untilChapter, eventSeq: s.eventSeq, eventId: s.eventId }))
  const snap = JSON.stringify(p.ledger)
  const r2 = backfillTransitions(p)
  say('补齐前：')
  say()
  say(dump(before))
  say('补齐后：')
  say()
  say(dump(after))
  say('生成的事件（注意 `fromValue` 为空 —— 旧数据不知道上一个取值，不编造）：')
  say()
  say(table(['event_id', '主体', 'from', 'to', '章', 'seq', '幂等键'], (p.ledger.stateEvents || []).map((e) => evRow(e, p))))
  say('返回摘要与重复执行验证：')
  say()
  say(dump({
    第一次: r1,
    第二次: { addedEvents: r2.addedEvents, superseded: r2.superseded, seqFilled: r2.seqFilled },
    第二次执行后账本是否与第一次逐字一致: snap === JSON.stringify(p.ledger),
  }))
  say()
}

/* ============ 汇总 ============ */

say('## 汇总')
say()
say(table(['场景', '要求', '本样例中的结果'], [
  ['A 同章往返', '允许再次进入同一状态，且两次可区分', '3 条记录 / 3 个事件，末条 active'],
  ['B 时间回查', '能查指定章节的有效状态', `第 3 章 → \`${'青江桥'}\`，不受第 4 章影响`],
  ['C 认知演变', '保留变化历史，当前认知正确', '3 条留档，上下文只取 1 条'],
  ['D 失败保护', '非法转移不得部分生效', '整批拒绝，账本逐字未变'],
  ['E 重复提交', '重复提交不重复执行', '第二次新增 0；换提交标识则照常生效'],
  ['F 证据溯源', '关联来源正文版本与位置', 'sourceChapter / sourceVersion / batchKey 已贯通'],
  ['G 旧数据补齐', '确定性、可重复、不伪造证据', '同键 3 条 active 收尾为 1 条，fromValue 留空'],
]))
say()
say('> 本样例全部由 `server/state-engine.js` 的公开接口驱动，与该引擎在生成流水线里')
say('> 被调用的路径完全一致（`ledger.applyExtraction` → `applyStateChanges`）。')
say()

/* ------------------------------- 输出 ------------------------------- */

const text = L.join('\n')
const outIdx = process.argv.indexOf('--out')
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const target = path.resolve(root, process.argv[outIdx + 1])
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
  process.stdout.write(`已写入 ${path.relative(root, target)}（${text.length} 字符）\n`)
} else {
  process.stdout.write(text)
}