import test from 'node:test'
import assert from 'node:assert/strict'
import { auditWriterSummaries, outlineAuditNotes, normalizeOutline } from '../server/pipeline.js'

/**
 * 章节概要审查：拦住「伏笔的回收真相（payoff）被改写后抄进 writerSummary」。
 *
 * 为什么需要它：`findLeaks` 只在**生成正文时**做逐字比对，而 payoff 被模型改写后
 * 字面对不上；等发现时已经晚了。这里把审查**前移到概要落盘**，
 * 代价为零、可在界面上提示，且不阻断生成（那批规划已经付过费）。
 *
 * 判据是三条可解释的减法，不做语义推断 —— 见 `auditWriterSummaries` 的注释。
 */

const hero = { name: '星野遥', publicIdentity: '观察部部长，学生会记录员', publicRole: '学生' }

function makeProject(foreshadows, entities = [hero]) {
  return { entities, outline: { foreshadows } }
}

test('payoff 的独有片段出现在 writerSummary 里 ⇒ 命中', () => {
  const fs = [{ id: 'f3', seed: '星野遥总在雨天去旧校舍，说姐姐讨厌雨天',
    payoff: '神代凛在雨天消失，雨天走廊是姐妹最后见面的意象' }]
  const volumes = [{ chapters: [
    { no: 4, writerSummary: '雨天走廊，遥提起姐姐讨厌雨天。', writerGoal: '读者看到遥的脆弱。' },
  ] }]
  const audit = auditWriterSummaries(volumes, fs, makeProject(fs))
  assert.equal(audit.length, 1)
  assert.equal(audit[0].chapterNo, 4)
  assert.equal(audit[0].foreshadowId, 'f3')
  assert.ok(audit[0].fragment.includes('雨天走廊'), `应命中最长片段，实际「${audit[0].fragment}」`)
})

test('writerGoal 也一并审查（不只是 writerSummary）', () => {
  const fs = [{ id: 'f1', seed: '桌上放着一封没署名的信', payoff: '寄件人是三年前失踪的哥哥' }]
  const volumes = [{ chapters: [
    { no: 7, writerSummary: '主角整理书桌。', writerGoal: '让读者看到信封的异样。' },
    { no: 8, writerSummary: '主角读完信得知寄件人身份。', writerGoal: '揭露寄件人。' },
  ] }]
  const audit = auditWriterSummaries(volumes, fs, makeProject(fs))
  assert.ok(audit.every((i) => i.chapterNo === 8), `只该命中第 8 章，实际 ${JSON.stringify(audit)}`)
})

test('seed 自己的措辞不算泄露（那是本就允许给表层的）', () => {
  const fs = [{ id: 'f1', seed: '旧部志最后一页写着佐仓悠真，墨水颜色不同',
    payoff: '神代凛三十年前预写名字，等待打破循环的人' }]
  const volumes = [{ chapters: [
    // writerSummary 逐字用了 seed 的说法 —— 这是对的，不该报
    { no: 1, writerSummary: '悠真发现旧部志最后一页写着佐仓悠真，墨水颜色不同。', writerGoal: '读者注意到异常。' },
  ] }]
  assert.deepEqual(auditWriterSummaries(volumes, fs, makeProject(fs)), [])
})

test('公开信息里的词（角色名 / 公开身份）不算泄露', () => {
  const fs = [{ id: 'f4', seed: '平板上有个加密文件夹',
    payoff: '文件夹里是学生会指示她监视观察部的证据' }]
  const volumes = [{ chapters: [
    // 「学生会」「观察部」都在 publicIdentity 里，是公开组织
    { no: 5, writerSummary: '学生会以人数不足为由要裁撤观察部。', writerGoal: '读者看到危机。' },
  ] }]
  assert.deepEqual(auditWriterSummaries(volumes, fs, makeProject(fs)), [])
})

test('虚词开头/结尾的片段被剔掉（「旧部志的」「自己的」这类不承载真相）', () => {
  const fs = [{ id: 'f2', seed: '一本写满失败的小本子',
    payoff: '她私下记录自己的不完美，与旧部志的完美体系形成对照' }]
  const volumes = [{ chapters: [
    { no: 3, writerSummary: '悠真撞见咲藏起一本写满失败的小本子，看到自己的倒影。', writerGoal: '读者看到咲的不完美。' },
  ] }]
  assert.deepEqual(auditWriterSummaries(volumes, fs, makeProject(fs)), [])
})

test('同一章同一伏笔只报最长的一条（短的是长的子串）', () => {
  const fs = [{ id: 'f3', seed: '雨天总去旧校舍',
    payoff: '雨天走廊是姐妹最后见面的地方' }]
  const volumes = [{ chapters: [
    { no: 4, writerSummary: '雨天走廊里，遥不肯多说。', writerGoal: '推进。' },
  ] }]
  const audit = auditWriterSummaries(volumes, fs, makeProject(fs))
  assert.equal(audit.length, 1, `应去重成一条，实际 ${JSON.stringify(audit)}`)
  assert.equal(audit[0].fragment, '雨天走廊')
})

test('没有伏笔 / 空 payoff / 空概要时不报错也不误报', () => {
  assert.deepEqual(auditWriterSummaries([], [], makeProject([])), [])
  assert.deepEqual(auditWriterSummaries([{ chapters: [] }], [{ id: 'f1', seed: 's', payoff: '' }], makeProject([])), [])
  const fs = [{ id: 'f1', seed: 's', payoff: '雨天走廊是姐妹最后见面的地方' }]
  assert.deepEqual(auditWriterSummaries([{ chapters: [{ no: 1, writerSummary: '', writerGoal: '' }] }], fs, makeProject(fs)), [])
})

test('不传 project（没有公开信息）时仍能工作，只是少一条降噪规则', () => {
  const fs = [{ id: 'f3', seed: '雨天总去旧校舍', payoff: '雨天走廊是姐妹最后见面的地方' }]
  const volumes = [{ chapters: [{ no: 4, writerSummary: '雨天走廊里，遥不肯多说。', writerGoal: '' }] }]
  const audit = auditWriterSummaries(volumes, fs)
  assert.equal(audit.length, 1)
})

test('纯函数：不修改传入的 volumes / foreshadows', () => {
  const fs = [{ id: 'f3', seed: '雨天总去旧校舍', payoff: '雨天走廊是姐妹最后见面的地方' }]
  const volumes = [{ chapters: [{ no: 4, writerSummary: '雨天走廊里，遥不肯多说。', writerGoal: '' }] }]
  const before = JSON.stringify({ fs, volumes })
  auditWriterSummaries(volumes, fs, makeProject(fs))
  assert.equal(JSON.stringify({ fs, volumes }), before, '审查不得原地修改输入')
})

test('诊断文案：指出章号与伏笔，并给出界面上真实存在的处理路径', () => {
  const fs = [{ id: 'f3', seed: '星野遥总在雨天去旧校舍，说姐姐讨厌雨天', payoff: '雨天走廊是姐妹最后见面的地方' }]
  const volumes = [{ chapters: [{ no: 4, writerSummary: '雨天走廊里，遥不肯多说。', writerGoal: '' }] }]
  const project = makeProject(fs)
  const notes = outlineAuditNotes(auditWriterSummaries(volumes, fs, project), project)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /第 4 章/)
  assert.match(notes[0], /伏笔「星野遥总在雨天去旧校舍/)
  assert.match(notes[0], /雨天走廊/)
  // 路径必须真实存在。
  // ⚠️ 2026-10-14 起改为指向**执笔页的「编辑本章写作任务」**（ChangeRequest kind `chapter_task_text`）：
  //    泄漏在**表层概要**里，改 payoff 修不掉它 —— 旧建议（去伏笔页改回收真相）当时是诚实的
  //    （那时 writerSummary 确实没有编辑入口），但现在已经有了真正的出口，建议必须跟着改。
  assert.match(notes[0], /执笔页/)
  assert.match(notes[0], /本章写作任务/)
  assert.doesNotMatch(notes[0], /创作资料与编辑 → 伏笔/, '不能指向修不好问题的动作')
  // 必须说清不自动改数据、也不阻断
  assert.match(notes[0], /不自动改写/)
  assert.match(notes[0], /不阻断生成/)
})

// normalizeOutline 有一条「至少需要 window-2 章」的下限，fixture 必须给够 3 章。
function rawOutlineWith(chapters) {
  return {
    cast: [{ name: '林舟', role: '主角' }],
    foreshadows: [{ id: 'f1', seed: '门缝里塞着一张纸条', payoff: '纸条是失踪的姐姐留的，信封背面画着家徽' }],
    volumes: [{ title: '卷一', chapters }],
  }
}
const filler = (n) => ({ no: n, title: `第${n}章`, summary: `作者侧：第${n}章推进`, goal: '推进',
  writerSummary: `第${n}章的表层动作。`, writerGoal: `读者看到第${n}章的变化。` })

test('normalizeOutline 把审查结果挂在 outline.summaryAudit 上', () => {
  const raw = rawOutlineWith([
    // writerSummary 没出现 payoff 的独有措辞（「暗号」「信封」「失踪」都没写），应不命中
    { no: 1, title: '开端', summary: '作者侧：他捡到纸条', goal: '推进',
      writerSummary: '他捡到纸条，愣了一下。', writerGoal: '读者看到纸条。' },
    filler(2), filler(3),
  ])
  const { outline } = normalizeOutline(raw, 10)
  assert.ok(Array.isArray(outline.summaryAudit), 'normalizeOutline 应产出 summaryAudit')
  assert.deepEqual(outline.summaryAudit, [])
})

test('normalizeOutline 遇到真实泄露时会产出非空审查结果', () => {
  const raw = rawOutlineWith([
    { no: 1, title: '开端', summary: '作者侧：他捡到纸条', goal: '推进',
      writerSummary: '他捡到纸条，信封背面画着家徽。', writerGoal: '读者看到纸条。' },
    filler(2), filler(3),
  ])
  const { outline } = normalizeOutline(raw, 10)
  assert.equal(outline.summaryAudit.length, 1)
  assert.equal(outline.summaryAudit[0].chapterNo, 1)
  assert.ok(outline.summaryAudit[0].fragment.includes('家徽') || outline.summaryAudit[0].fragment.includes('信封背面'))
})
