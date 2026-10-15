import test from 'node:test'
import assert from 'node:assert/strict'
import { auditWriterSummaries, outlineAuditNotes, WEAK_OVERLAP } from '../server/pipeline.js'

/**
 * 概要审查的**回收豁免**。
 *
 * 实测（新书《明日邮戳》window 重排后）：诊断把 5 条全报出来，其中 3 条正是**回收章本身**
 * （ch7 回收 f3、ch9 回收 f1/f5）—— 那些章的剧情就是「把真相说出来」。
 * 每次重排都刷一遍这种噪音，会把真正要看的「提前泄露」淹掉。
 * 判据：`本章章号 >= 该伏笔的回收章` ⇒ 真相在这一章或更早已经公开 ⇒ 不算提前泄露。
 */

const chap = (no, writerSummary) => ({ no, writerSummary, writerGoal: '' })
const fs1 = { id: 'f1', seed: '邮戳日期偶尔早一天晚一天', payoff: '邮戳日期对应的是陈默做出选择的先后顺序', payoffChapter: 8 }
const project = { entities: [] }

test('回收章本身：真相在这里合法公开 ⇒ 不报', () => {
  const audit = auditWriterSummaries([{ chapters: [chap(8, '邮戳日期对应的是陈默做出选择的先后顺序。')] }], [fs1], project)
  assert.deepEqual(audit, [], JSON.stringify(audit))
})

test('回收之后的章节：真相早已公开 ⇒ 不报（ch10 回望 ch8 的揭示是正常的）', () => {
  const audit = auditWriterSummaries([{ chapters: [chap(10, '他想起邮戳日期对应的是陈默做出选择的先后顺序。')] }], [fs1], project)
  assert.deepEqual(audit, [], JSON.stringify(audit))
})

test('⛔ 回收之前：这才是要看的「提前泄露」，必须报', () => {
  const audit = auditWriterSummaries([{ chapters: [chap(5, '他猜到了邮戳日期对应的是陈默做出选择的先后顺序。')] }], [fs1], project)
  assert.ok(audit.length >= 1, JSON.stringify(audit))
  assert.equal(audit[0].chapterNo, 5)
  // payoffAround 是**片段前后各 8 字**的窗口，所以只断言「窗口里能看到真相那一段」，
  // 不能要求它包含完整的真相句（那是窗口宽度决定的，不是行为）
  assert.ok(audit[0].payoffAround.includes('陈默做出选择的'), audit[0].payoffAround)
  assert.ok(audit[0].overlap >= 6, `重叠至少 6 字，实际 ${audit[0].overlap}`)
})

test('回收章未确认（null）时仍然报 —— 那是「关联待审核」，该让人看一眼', () => {
  const f = { id: 'f9', seed: '空档', payoff: '档案室暗格里那封没寄出的信', payoffChapter: null }
  const audit = auditWriterSummaries([{ chapters: [chap(3, '他在档案室暗格里那封没寄出的信前面停了很久。')] }], [f], project)
  assert.ok(audit.length >= 1, JSON.stringify(audit))
})

test('诊断文案说的是「去执笔页改写作任务」，并且如实说明不阻断', () => {
  const audit = auditWriterSummaries([{ chapters: [chap(5, '他猜到了邮戳日期对应的是陈默做出选择的先后顺序。')] }], [fs1], project)
  const notes = outlineAuditNotes(audit, { outline: { foreshadows: [fs1] } })
  assert.match(notes[0], /执笔页/)
  assert.match(notes[0], /不阻断生成/)
  assert.match(notes[0], /重叠 \d+ 字/)
})

test('弱信号标记与排序：3~4 字的「共用措辞」排在后面并标注，强信号仍说「可能泄露」', () => {
  // f2 只共享一个 3 字通用词（分拣线）；f3 共享 6 字以上的实质措辞
  const f2 = { id: 'f2', seed: '旧邮路的最里侧格口', payoff: '信件不经营业厅，直接由分拣线回流', payoffChapter: 20 }
  const f3 = { id: 'f3', seed: '一把没编号的小钥匙', payoff: '那把没编号的小钥匙是前任分拣员留下的退路', payoffChapter: 21 }
  const chapter = chap(6, '他听说分拣线的事。他还发现那把钥匙是前任分拣员留的。')
  const audit = auditWriterSummaries([{ chapters: [chapter] }], [f2, f3], project)

  const weak = audit.find((x) => x.foreshadowId === 'f2')
  const strong = audit.find((x) => x.foreshadowId === 'f3')
  assert.ok(weak && strong, JSON.stringify(audit.map((x) => [x.foreshadowId, x.overlap, x.fragment])))
  assert.ok(strong.overlap > WEAK_OVERLAP, `强信号重叠应当更长：${strong.overlap}「${strong.fragment}」`)
  assert.ok(weak.overlap <= WEAK_OVERLAP, `弱信号应当是短重叠：${weak.overlap}「${weak.fragment}」`)

  const notes = outlineAuditNotes(audit, { outline: { foreshadows: [f2, f3] } })
  const note = notes[0]
  assert.match(note, /弱信号：可能只是共用措辞/, note)
  assert.match(note, /这可能把回收真相写成了正文可见内容/, '有强信号时仍要按「可能泄露」措辞')
  // 强信号必须排在弱信号之前
  assert.ok(note.indexOf('弱信号') > note.indexOf('前任分拣员'), note)
})

test('全是弱信号时，文案改成「多半只是共用措辞」，不再吓唬人', () => {
  const f = { id: 'f7', seed: '一把没编号的钥匙', payoff: '那把钥匙上没有编号，因为夜班记录被人改过', payoffChapter: 20 }
  const audit = auditWriterSummaries([{ chapters: [chap(6, '他翻了翻夜班记录，没看出什么。')] }], [f], project)
  assert.ok(audit.length >= 1, JSON.stringify(audit))
  assert.ok(audit[0].overlap <= WEAK_OVERLAP, `这条应当是弱信号：${audit[0].overlap}「${audit[0].fragment}」`)
  const notes = outlineAuditNotes(audit, { outline: { foreshadows: [f] } })
  assert.match(notes[0], /多半只是\*\*共用措辞\*\*/)
  assert.doesNotMatch(notes[0], /这可能把回收真相写成了正文可见内容/)
})
