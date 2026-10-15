/**
 * 数据迁移 v1 → v2
 *
 * 实施要求（第 2 轮第 1 条）逐条对应：
 *   · 尽量确定性 —— 全程不调用模型；无法确定的关联宁可留空，也不推测
 *   · 可重复执行   —— ID 由内容派生，且按 schemaVersion 短路，重复跑不会产生重复记录
 *   · 不伪造证据   —— 出处未知的旧记录标记 sourceChapter:null + verified:false
 *   · 不改动正文   —— chapters[].text 原样保留
 *   · 可回滚       —— 由调用方在迁移前做文件级备份（见 scripts/migrate-data.mjs）
 *
 * 迁移内容：
 *   1) outline.cast  → entities[]，并建立「旧名 → 实体 ID」映射
 *   2) 章节 cast（名字数组）→ 实体 ID 数组
 *   3) 旧 state.facts[]   → ledger.canonicalFacts[]
 *     旧 state.threads[] → ledger.plotThreads[]
 *   4) state 暂时保留（deprecated），待状态账本切换完成后移除
 */
import {
  SCHEMA_VERSION,
  TRUST,
  entityId,
  foreshadowId,
  makeEntity,
  makeFact,
  makeThread,
  emptyLedger,
} from './schema.js'
import { backfillTransitions } from './state-engine.js'
import { normalizeForeshadows } from './foreshadow.js'

/** 旧版中文定位 → 可公开的定位。「对手 / 反派」属作者视角，不投影给正文 */
const LEGACY_ROLE_MAP = {
  主角: '主角',
  女主: '女主角',
  男主: '男主角',
  配角: '配角',
  对手: '',
  反派: '',
}

/** 目标版本已达标则短路，保证迁移幂等 */
export function isMigrated(project) {
  return Number(project?.schemaVersion || 1) >= SCHEMA_VERSION
}

/**
 * v2 内部补丁：给已经迁移过的数据补上后加的必填项。
 *
 * 背景：schemaVersion 还是 2，但 R1 新增了两项**有运行后果**的字段 ——
 *   1) 账本条目的 trust（缺失会导致「无出处记录默认放行」）
 *   2) 伏笔 ID（空串会让「章节 → 伏笔 → 线索」整条链断掉）
 * 已迁移的项目不会重走 v1→v2 流程，所以需要一次独立、可重复的补齐。
 *
 * 幂等：只补缺，不覆盖已有值；重复执行不会改变数据。
 */
function needsV2Patch(p) {
  const led = p.ledger || {}
  const buckets = [led.canonicalFacts, led.currentState, led.characterKnowledge, led.plotThreads]
  for (const arr of buckets) {
    for (const it of arr || []) {
      if (it && it.trust === undefined) return true
    }
  }
  for (const f of p.outline?.foreshadows || []) {
    if (!f.id) return true
  }
  return needsR2Patch(p) || needsR3Patch(p)
}

/**
 * R2 是否还需补齐：
 *   账本缺 stateEvents 桶，或任一状态/认知记录还没有 eventId
 *   （eventId 是「证据溯源」与「历史回放」的锚点，缺了这两件事都做不了）。
 */
function needsR3Patch(p) {
  return !Array.isArray(p.ledger?.foreshadowEvents) ||
    (p.outline?.foreshadows || []).some((f) => !f.linkStatus || !Array.isArray(f.prerequisiteEventIds) || !f.lifecycle || f.plantChapter === undefined || f.payoffChapter === undefined)
}

function needsR2Patch(p) {
  const led = p.ledger || {}
  if (!Array.isArray(led.stateEvents)) return true
  return [...(led.currentState || []), ...(led.characterKnowledge || [])].some((it) => it && !it.eventId)
}

function patchV2(input) {
  const notes = []
  const p = structuredClone(input)

  // 1) 账本条目补 trust —— 「有出处即可信，无出处一律隔离」
  const buckets = [
    ['canonicalFacts', p.ledger?.canonicalFacts],
    ['currentState', p.ledger?.currentState],
    ['characterKnowledge', p.ledger?.characterKnowledge],
    ['plotThreads', p.ledger?.plotThreads],
  ]
  const counters = {}
  for (const [name, arr] of buckets) {
    let quarantined = 0
    let trusted = 0
    for (const it of arr || []) {
      if (!it || it.trust !== undefined) continue
      const src = it.sourceChapter ?? it.sinceChapter ?? null
      if (src === null || src === undefined) {
        it.trust = TRUST.LEGACY_UNVERIFIED
        quarantined++
      } else {
        it.trust = TRUST.CANONICAL
        trusted++
      }
    }
    if (quarantined || trusted) counters[name] = { trusted, quarantined }
  }
  for (const [name, c] of Object.entries(counters)) {
    notes.push(`${name}: 补 trust（可信 ${c.trusted} / 隔离 ${c.quarantined}）`)
  }

  // 2) 伏笔补 ID 与关联状态
  let fsPatched = 0
  if (p.outline) {
    p.outline = {
      ...p.outline,
      foreshadows: (p.outline.foreshadows || []).map((f) => {
        if (f.id) return f
        fsPatched++
        return {
          ...f,
          id: foreshadowId(f.seed),
          plantChapter: f.plantChapter ?? null,
          payoffChapter: f.payoffChapter ?? null,
          linkStatus: 'needsReview',
        }
      }),
    }
  }
  if (fsPatched) notes.push(`伏笔补 ID ${fsPatched} 条（关联状态标 needsReview，待模型辅助迁移）`)

  // 3) R2 状态转移：补事件日志与转移字段（确定性、只补缺、可重复执行）
  const r2 = backfillTransitions(p)
  if (r2.addedEvents || r2.superseded || r2.seqFilled) {
    notes.push(...r2.notes)
  }

  if (normalizeForeshadows(p)) notes.push('R3：补齐伏笔计划与证据事件结构（未认可任何推断关联）')
  p.migrations = [...(p.migrations || []), { patch: 'v2-r1', at: new Date().toISOString(), notes }]
  return { project: p, changed: true, notes }
}

/** 文本中出现的实体名 → 实体 ID（字符串包含属于事实判断，不是推测） */
function matchEntities(text, nameToId) {
  const hits = new Set()
  const t = String(text || '')
  for (const [name, id] of nameToId) {
    if (name && t.includes(name)) hits.add(id)
  }
  return [...hits]
}

export function migrateProject(input) {
  const notes = []
  if (isMigrated(input)) {
    // 已迁移过，但仍可能需要补 v2 内部新增的必填项（幂等，只补缺）
    if (needsV2Patch(input)) return patchV2(input)
    return { project: input, changed: false, notes: ['已是 v2，无需迁移'] }
  }

  const p = { ...input }
  const createdAt = new Date().toISOString()

  /* ------------------ 1) 实体表 + 旧名到 ID 的映射 ------------------ */
  const entities = new Map((p.entities || []).map((e) => [e.id, e]))
  const nameToId = new Map()

  for (const c of p.outline?.cast || []) {
    const name = String(c.name || '').trim()
    if (!name) continue
    const id = entityId('character', name)
    nameToId.set(name, id)
    if (entities.has(id)) continue

    const legacyRole = String(c.role || '')
    const entity = makeEntity({
      kind: 'character',
      name,
      publicRole: LEGACY_ROLE_MAP[legacyRole] ?? '',
      // 旧 identity 无法判别公开/隐藏，整体归入作者侧 —— 宁可少给，不可错给
      publicIdentity: '',
      authorRole: legacyRole,
      secret: c.identity ? String(c.identity) : null,
      want: String(c.want || ''),
      fear: String(c.fear || ''),
    })
    entity.migrationNote = 'legacy: 旧 identity 整体归入 secret，公开身份待拆分'
    entities.set(id, entity)
    notes.push(`角色「${name}」→ ${id}`)
  }

  /* --------------------- 2) 大纲与章节的引用改写 --------------------- */
  if (p.outline) {
    const volumes = (p.outline.volumes || []).map((v) => ({
      ...v,
      chapters: (v.chapters || []).map((ch) => {
        // 章节级出场白名单：旧数据没有该字段，用「概要/目标里出现过的角色名」作确定性推断
        const source = `${ch.summary || ''} ${ch.goal || ''}`
        const castIds = matchEntities(source, nameToId)
        const inferred = castIds.length > 0
        return {
          ...ch,
          cast: castIds,
          ...(inferred ? { castSource: 'inferred-from-summary' } : {}),
          foreshadows: Array.isArray(ch.foreshadows) ? ch.foreshadows : [],
        }
      }),
    }))

    p.outline = {
      ...p.outline,
      cast: (p.outline.cast || []).map((c) => {
        const name = String(c.name || '').trim()
        return { ...c, entityId: nameToId.get(name) || null }
      }),
      foreshadows: (p.outline.foreshadows || []).map((f) => ({
        ...f,
        // 旧数据没有伏笔 ID，这里按 seed 派生一个稳定 ID。
        // 空 ID 会让「章节 → 伏笔 → 线索」整条关联链断掉（第 2 轮评审问题 1）。
        id: f.id ? String(f.id) : foreshadowId(f.seed),
        entityIds: matchEntities(`${f.seed || ''} ${f.payoff || ''}`, nameToId),
        // 铺设/回收章号旧数据没有，留空并标注待补全 —— 不假装已经关联
        plantChapter: f.plantChapter ?? null,
        payoffChapter: f.payoffChapter ?? null,
        linkStatus: f.plantChapter || f.payoffChapter ? 'explicit' : 'needsReview',
      })),
      volumes,
    }
  }

  /* ------------------------ 3) 旧账本 → 四类账本 ------------------------ */
  const ledger = emptyLedger()
  const oldState = p.state || {}

  for (const raw of oldState.facts || []) {
    const text = typeof raw === 'string' ? raw : String(raw?.text || '')
    if (!text.trim()) continue
    const item = makeFact({
      text,
      entityIds: matchEntities(text, nameToId),
      sourceChapter: null, // 旧数据没有出处，留空而不是编一个
      verified: false, // 与「待验证」同义
      // 运行行为：trust 非 canonical ⇒ 不进正文上下文，只在 diagnostics 里报出。
      // 「保留旧数据」不等于「允许旧数据继续污染上下文」（第 2 轮评审决策 2）。
      trust: TRUST.LEGACY_UNVERIFIED,
    })
    item.migrationNote = 'legacy: 出处未知，待反向提取补充证据后转正式记录'
    ledger.canonicalFacts.push(item)
  }
  notes.push(
    `旧 facts ${(oldState.facts || []).length} 条 → canonicalFacts（trust=legacy_unverified，隔离不进正文）`
  )

  for (const raw of oldState.threads || []) {
    const text = typeof raw === 'string' ? raw : String(raw?.text || '')
    if (!text.trim()) continue
    const item = makeThread({ text, status: 'open', sourceChapter: null, trust: TRUST.LEGACY_UNVERIFIED })
    item.entityIds = matchEntities(text, nameToId)
    item.migrationNote = 'legacy: 出处未知，待验证'
    ledger.plotThreads.push(item)
  }
  notes.push(`旧 threads ${(oldState.threads || []).length} 条 → plotThreads（trust=legacy_unverified，隔离不进正文）`)

  /* --------------------------- 4) 版本与记录 --------------------------- */
  p.schemaVersion = SCHEMA_VERSION
  p.headVersion = Number(p.headVersion) || (p.chapters || []).length
  // 章节规模：旧数据没有用户设定，用大纲总章数兜底，保证后续重新规划有依据
  if (!p.targetChapters) p.targetChapters = p.outline?.totalChapters || 34
  p.entities = [...entities.values()]
  p.ledger = ledger
  normalizeForeshadows(p) // 旧作品的候选关联继续 needsReview，不自动授权
  p.migrations = [
    ...(p.migrations || []),
    { from: 1, to: SCHEMA_VERSION, at: createdAt, notes },
  ]
  // state 暂留作兼容层，等状态账本切换完成后移除
  p.state = { ...oldState, deprecated: true }

  return { project: p, changed: true, notes }
}
