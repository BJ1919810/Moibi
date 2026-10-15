import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateProject, isMigrated } from '../server/migrate.js'
import { entityId, validateProject, SCHEMA_VERSION } from '../server/schema.js'

/* ===================== v1 旧格式 fixture ===================== */

function v1Project() {
  return {
    id: 'p_legacy',
    title: '十年雨信',
    genre: '悬疑',
    idea: '主角在雨夜收到一封来自十年后的信',
    chapters: [
      { no: 1, title: '雨夜投递', text: '雨从傍晚开始下，一直没有停。', summary: '收到信', wordCount: 16 },
      { no: 2, title: '第三天的新闻', text: '雨到第三天夜里才停。', summary: '看到新闻', wordCount: 10 },
    ],
    outline: {
      logline: '档案修复师收到来自十年后的信。',
      theme: '遗忘不是赦免。',
      style: '短句为主，冷硬克制。',
      cast: [
        { name: '沈砚', role: '主角', identity: '32岁，市档案馆文书修复员，独居', want: '查明真相', fear: '怕自己是帮凶' },
        { name: '顾行舟', role: '对手', identity: '实为十年前死者林晚之子，筹划此局十年', want: '逼沈砚揭开真相', fear: '怕母亲被遗忘' },
        { name: '宋瓷', role: '女主', identity: '30岁，调查记者', want: '做出报道', fear: '被清算' },
      ],
      foreshadows: [
        { seed: '信封上的邮戳来自城南邮局', payoff: '信是顾行舟亲手投递的', plantAt: 10, revealAt: 26 },
      ],
      volumes: [
        {
          title: '卷一',
          goal: '让预言应验',
          chapters: [
            { no: 1, title: '雨夜投递', summary: '沈砚在信箱里收到一封信', goal: '他保留信封' },
            { no: 5, title: '记者的名片', summary: '宋瓷找上门', goal: '获得外部线索' },
            { no: 26, title: '十年布局', summary: '顾行舟承认全部手法', goal: '机制被解释' },
          ],
        },
      ],
      totalChapters: 3,
    },
    state: {
      facts: ['沈砚收到一封署名自己的信。', '顾行舟是档案馆新来的志愿者，二十六岁。', '宋瓷确认死者是林晚。'],
      threads: ['沈砚左手腕有一道旧疤，他不记得来源。', '信上的落款日期还没有到。'],
      lastSummary: '收到信',
    },
    usage: { calls: 5, inputTokens: 7233, outputTokens: 13443, reasoningTokens: 4447 },
  }
}

/* ========================= 迁移正确性 ========================= */

test('迁移后结构合法且带版本记录', () => {
  const { project, changed, notes } = migrateProject(v1Project())
  assert.equal(changed, true)
  assert.equal(project.schemaVersion, SCHEMA_VERSION)
  assert.equal(project.migrations.length, 1)
  assert.equal(project.migrations[0].from, 1)
  assert.ok(notes.length > 0)
  assert.deepEqual(validateProject(project), [])
})

test('三个角色都生成了实体，且旧 identity 整体归入 secret', () => {
  const { project } = migrateProject(v1Project())
  assert.equal(project.entities.length, 3)

  const gu = project.entities.find((e) => e.name === '顾行舟')
  assert.ok(gu)
  assert.equal(gu.id, entityId('character', '顾行舟'))
  assert.equal(gu.secret, '实为十年前死者林晚之子，筹划此局十年')
  assert.equal(gu.publicIdentity, '', '旧数据无法判别公开部分，应留空而非猜测')
  assert.equal(gu.authorRole, '对手')
  assert.equal(gu.publicRole, '', '「对手」属作者视角，不得成为公开定位')

  const shen = project.entities.find((e) => e.name === '沈砚')
  assert.equal(shen.publicRole, '主角')
  assert.equal(shen.secret, '32岁，市档案馆文书修复员，独居')
})

test('章节 cast 由名字改写为实体 ID，并标注推断来源', () => {
  const { project } = migrateProject(v1Project())
  const ch1 = project.outline.volumes[0].chapters[0]
  assert.deepEqual(ch1.cast, [entityId('character', '沈砚')])
  assert.equal(ch1.castSource, 'inferred-from-summary')

  const ch26 = project.outline.volumes[0].chapters[2]
  assert.ok(ch26.cast.includes(entityId('character', '顾行舟')))
  // 第 26 章的概要/目标里没有出现沈砚，因此不应被推断进来（证明推断是精确的）
  assert.equal(ch26.cast.includes(entityId('character', '沈砚')), false)
})

test('旧 facts 全部转为 canonicalFacts，出处标空、标记待验证', () => {
  const { project } = migrateProject(v1Project())
  const facts = project.ledger.canonicalFacts
  assert.equal(facts.length, 3)
  for (const f of facts) {
    assert.equal(f.sourceChapter, null, '旧数据没有出处，不得编造')
    assert.equal(f.verified, false, '应标记为待验证')
    assert.equal(f.status, 'active')
  }
})

test('事实中出现的角色名会被确定性关联到实体 ID', () => {
  const { project } = migrateProject(v1Project())
  const guFact = project.ledger.canonicalFacts.find((f) => f.text.includes('顾行舟'))
  assert.ok(guFact.entityIds.includes(entityId('character', '顾行舟')))
  assert.equal(guFact.entityIds.includes(entityId('character', '沈砚')), false)
})

test('旧 threads 转为 plotThreads 且状态为 open', () => {
  const { project } = migrateProject(v1Project())
  const threads = project.ledger.plotThreads
  assert.equal(threads.length, 2)
  for (const t of threads) assert.equal(t.status, 'open')
})

test('伏笔保留原字段并补上实体关联', () => {
  const { project } = migrateProject(v1Project())
  const f = project.outline.foreshadows[0]
  assert.equal(f.seed, '信封上的邮戳来自城南邮局')
  assert.equal(f.payoff, '信是顾行舟亲手投递的')
  assert.equal(f.plantAt, 10)
  assert.ok(f.entityIds.includes(entityId('character', '顾行舟')))
})

/* ========================= 幂等与不变性 ========================= */

test('重复迁移是幂等的：第二次直接短路', () => {
  const first = migrateProject(v1Project()).project
  const second = migrateProject(first)
  assert.equal(second.changed, false)
  assert.equal(second.project, first, '应原样返回，不产生新对象')
  assert.equal(isMigrated(first), true)
})

test('迁移可重复执行且不产生重复实体（对同一份旧数据跑两次）', () => {
  const a = migrateProject(v1Project()).project
  const b = migrateProject(v1Project()).project
  assert.equal(a.entities.length, b.entities.length)
  assert.deepEqual(
    a.entities.map((e) => e.id).sort(),
    b.entities.map((e) => e.id).sort()
  )
  assert.deepEqual(
    a.ledger.canonicalFacts.map((f) => f.id).sort(),
    b.ledger.canonicalFacts.map((f) => f.id).sort()
  )
})

test('原有正文一字未改', () => {
  const before = v1Project()
  const { project } = migrateProject(before)
  assert.equal(project.chapters.length, before.chapters.length)
  for (let i = 0; i < before.chapters.length; i++) {
    assert.equal(project.chapters[i].text, before.chapters[i].text)
    assert.equal(project.chapters[i].no, before.chapters[i].no)
  }
})

test('用量统计与作品元信息保持不变', () => {
  const before = v1Project()
  const { project } = migrateProject(before)
  assert.deepEqual(project.usage, before.usage)
  assert.equal(project.title, before.title)
  assert.equal(project.genre, before.genre)
  assert.equal(project.outline.totalChapters, before.outline.totalChapters)
})

test('headVersion 按已提交章节数初始化', () => {
  const { project } = migrateProject(v1Project())
  assert.equal(project.headVersion, 2)
})

test('旧 state 保留为兼容层并标注 deprecated', () => {
  const { project } = migrateProject(v1Project())
  assert.equal(project.state.deprecated, true)
  assert.equal(project.state.facts.length, 3)
})
