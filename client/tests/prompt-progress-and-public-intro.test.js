import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWriterPacket, renderWriterPacket, tailSentences } from '../server/projection.js'
import { createChangeService } from '../server/change-request.js'
import { emptyLedger } from '../server/schema.js'

/**
 * 主人四问的后端部分：
 *   ① 前情按**完整句子**取（不再 slice 出残句）
 *   ② 末章不该还要求「结尾为下一章留下接口」
 *   ③ 提示词里给**全书进度**
 *   ④ `publicLoglineApproved / publicThemeApproved` 的「有读无写」修掉（公开简介/主题能进正文了）
 */

const para = (n) => `第${n}句，走廊尽头的窗子开着，风把练习册的纸角掀起来又放下。`

const baseProject = (over = {}) => ({
  id: 'p_prog', schemaVersion: 2, headVersion: 2, editRevision: 0, targetChapters: 10, title: '进度测试',
  preferences: { styleSpec: '第三人称限知；冷峻克制。' },
  chapters: [{ no: 1, status: 'committed', summary: '开端', text: Array.from({ length: 40 }, (_, i) => para(i + 1)).join('') }],
  entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员' }],
  outline: {
    totalChapters: 10, plannedDetailThrough: 2, theme: '作者侧主题（永进不了正文）',
    foreshadows: [], volumes: [{ title: '卷一', chapters: [
      { no: 1, title: '开端', summary: '开端', cast: ['ent_a'] },
      { no: 2, title: '继续', summary: '继续', cast: ['ent_a'] },
      { no: 10, title: '收束', summary: '收束', cast: ['ent_a'] },
    ] }],
  },
  ledger: emptyLedger(),
  ...over,
})

/* ---------------- ① 前情按完整句子取 ---------------- */

test('tailSentences：预算内原样返回；超出时首尾都是完整句子（不留残句开头）', () => {
  const short = para(1)
  assert.equal(tailSentences(short, 420), short)

  const long = Array.from({ length: 40 }, (_, i) => para(i + 1)).join('')
  const cut = tailSentences(long, 420)
  assert.ok(cut.length >= 420, `至少要够预算：${cut.length}`)
  assert.ok(cut.length <= 420 * 3, '不能失控')
  assert.ok(cut.startsWith('第'), `开头必须是完整句子，实际：「${cut.slice(0, 12)}」`)
  assert.ok(/[。！？…]["'」』）)]?$/.test(cut), `结尾应当是句末，实际结尾：「${cut.slice(-12)}」`)
  assert.ok(long.endsWith(cut), '必须是原文的结尾片段（不能改动内容）')
  // 精确判据：切点必须落在**句子边界**上（前一字符是句末标点，或正好从头开始）
  const at = long.length - cut.length
  assert.ok(at === 0 || /[。！？…]/.test(long[at - 1]),
    `必须从句子边界开始，实际前一个字符是「${long[at - 1]}」`)
})

test('提示词里的【上一章结尾原文】开头是完整句子', () => {
  const packet = buildWriterPacket(baseProject(), 2)
  const text = renderWriterPacket(packet)
  const m = text.match(/【上一章结尾原文】\n……([^\n]+)/)
  assert.ok(m, '应当有上一章结尾原文')
  assert.ok(m[1].startsWith('第'), `开头不能是残句：${m[1].slice(0, 12)}`)
})

/* ---------------- ②③ 进度 + 末章规矩 ---------------- */

test('提示词给出全书进度；非末章要求「留下接口」', () => {
  const text = renderWriterPacket(buildWriterPacket(baseProject(), 2))
  assert.match(text, /【进度】第 2 章 \/ 共 10 章/)
  assert.match(text, /结尾为下一章留下接口/)
  assert.doesNotMatch(text, /全书\*\*最后一章\*\*/)
})

test('⛔ 末章不能再要求「结尾为下一章留下接口」（否则模型会在全书结尾留假接口）', () => {
  const text = renderWriterPacket(buildWriterPacket(baseProject(), 10))
  assert.match(text, /【进度】第 10 章 \/ 共 10 章（全书\*\*最后一章\*\*）/)
  assert.doesNotMatch(text, /结尾为下一章留下接口/)
  assert.match(text, /把已经铺设的线索收到位/)
})

/* ---------------- ④ 公开简介 / 主题：修掉「有读无写」 ---------------- */

const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-intro-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pf = path.join(dir, 'project.json')
  fs.writeFileSync(pf, JSON.stringify(baseProject()))
  const repo = {
    getProject: () => JSON.parse(fs.readFileSync(pf, 'utf8')),
    getChange: (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'))) } catch { return null } },
    saveChange: (c) => { fs.writeFileSync(path.join(dir, c.id + '.json'), JSON.stringify(c)); return c },
    listChanges: () => [],
    commitProjectEdit(next, head, edit) {
      const cur = repo.getProject()
      if (cur.editRevision !== edit || next.editRevision !== edit + 1) throw Error('冲突')
      fs.writeFileSync(pf, JSON.stringify(next)); return next
    },
    listRuns: () => [], saveRun: (r) => r, getRun: () => null,
  }
  return { repo, service: createChangeService(repo) }
}

test('公开简介/主题：作者提交即批准，并**真的进入正文提示词**；清空 = 撤回', (t) => {
  const { repo, service } = fixture(t)
  const before = renderWriterPacket(buildWriterPacket(repo.getProject(), 2))
  assert.match(before, /沿当前人物处境与已公开冲突展开故事/, '未批准时是中性占位')
  assert.match(before, /【主题】—/)

  const r = service.approve(service.create('p_prog', {
    kind: 'reader_intro', field: 'logline', value: '1998 年秋天，分拣员每天收到一封写给自己的信。',
  }).id)
  assert.equal(r.project.outline.publicLoglineApproved, true, '作者亲手提交 = 批准')
  const mid = renderWriterPacket(buildWriterPacket(repo.getProject(), 2))
  assert.match(mid, /1998 年秋天，分拣员每天收到一封写给自己的信。/)
  assert.deepEqual(r.diff.map((x) => x.label), ['读者简介'])

  // 主题是另一条独立通道
  service.approve(service.create('p_prog', { kind: 'reader_intro', field: 'theme', value: '关于迟到二十年的道歉' }).id)
  assert.match(renderWriterPacket(buildWriterPacket(repo.getProject(), 2)), /【主题】关于迟到二十年的道歉/)

  // 清空提交 = 撤回公开 ⇒ 退回中性占位（作者侧 theme 仍然不进正文）
  const rev = service.approve(service.create('p_prog', { kind: 'reader_intro', field: 'logline', value: '' }).id)
  assert.equal(rev.project.outline.publicLoglineApproved, false)
  const after = renderWriterPacket(buildWriterPacket(repo.getProject(), 2))
  assert.match(after, /沿当前人物处境与已公开冲突展开故事/)
  assert.doesNotMatch(after, /作者侧主题（永进不了正文）/, '作者侧主题永远不得进入提示词')
})
