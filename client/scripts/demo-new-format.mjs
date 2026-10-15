/**
 * 演示：新格式大纲下的 WriterPacket 投影效果。
 *
 * 与 dump-writer-packet.mjs 的区别：那个跑真实项目（旧格式数据），
 * 这个用一份带完整 public/secret 拆分的小样例，直观展示
 * 「公开信息进正文、秘密留在作者侧」以及「出场人物白名单」两项机制。
 *
 * 用法：node scripts/demo-new-format.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWriterPacket, renderWriterPacket, findLeaks } from '../server/projection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const project = {
  id: 'demo_new_format',
  title: '潮汐档案',
  genre: '悬疑',
  idea: '海边的档案员发现潮水每天退回一页失踪者的记录',
  outline: {
    logline: '档案员在退潮后的礁石间捡到失踪者的记录，越查越像自己写的。',
    theme: '被抹去的人，靠别人的记忆活着。',
    style: '第三人称限知，冷硬克制，海与纸的意象。',
    cast: [
      {
        name: '陈屿',
        role: '主角',
        publicRole: '县档案馆档案员',
        publicIdentity: '41岁，独居，右手小指缺一节，做事慢而准',
        secret: null,
      },
      {
        name: '沈知白',
        role: '对手',
        publicRole: '海边民宿老板',
        publicIdentity: '三十来岁，话少，总在退潮时出门，对档案编号异常熟悉',
        secret: '实为被宣告死亡的原档案员，本名与陈屿的兄长同名；整场失踪案是他为掩盖自己伪造的死亡记录而布置',
      },
      {
        name: '林素',
        role: '配角',
        publicRole: '失踪者的妹妹',
        publicIdentity: '常年戴孝，每周三来查一次旧报',
        secret: '她早就知道兄长没死，一直在替他把风',
      },
    ],
    foreshadows: [
      {
        id: 'f1',
        seed: '档案馆的目录里，编号 217 到 219 之间空着一格',
        payoff: '那一格原本是陈屿兄长的档案，被沈知白亲手抽走销毁',
        plantAt: 2,
        revealAt: 14,
      },
    ],
    volumes: [
      {
        title: '卷一 退潮',
        goal: '让陈屿确认记录确实被人为投递',
        chapters: [
          {
            no: 1,
            title: '第一页',
            summary: '退潮后，礁石缝里夹着一张被海水泡软的档案页',
            goal: '陈屿把纸带回馆里，认出了编号 217',
            cast: ['陈屿'],
            foreshadows: [{ id: 'f1', action: 'plant' }],
          },
          {
            no: 8,
            title: '民宿老板',
            summary: '陈屿在退潮的海边遇到民宿老板沈知白',
            goal: '两人第一次正面交谈，陈屿察觉对方熟悉档案编号',
            cast: ['陈屿', '沈知白'],
            foreshadows: [],
          },
          {
            no: 14,
            title: '空着的那一格',
            summary: '陈屿查清 217 号档案被人抽走的经过',
            goal: '确认抽走档案的人就在岛上',
            cast: ['陈屿', '沈知白', '林素'],
            foreshadows: [{ id: 'f1', action: 'pay_off' }],
          },
        ],
      },
    ],
    totalChapters: 3,
  },
  chapters: [],
  state: {
    facts: [
      { text: '陈屿在礁石缝里捡到一页编号 217 的档案纸', visibility: 'public' },
      { text: '沈知白其实早已被宣告死亡', visibility: 'secret' },
    ],
    threads: [
      { text: '目录里编号 217 到 219 之间空着一格', visibility: 'public' },
    ],
  },
}

const outDir = path.join(ROOT, 'docs')
fs.mkdirSync(outDir, { recursive: true })

const md = [
  '# WriterPacket 投影演示（新格式大纲）',
  '',
  '样例作品为虚构，用于展示两项机制：**公开/隐藏字段拆分** 与 **出场人物白名单**。',
  '',
]

for (const no of [1, 8, 14]) {
  const packet = buildWriterPacket(project, no, { wordCount: 2500 })
  const rendered = renderWriterPacket(packet)
  const leaks = findLeaks(packet, project)

  md.push(
    `---`,
    '',
    `## 第 ${no} 章｜${packet.task.title}`,
    '',
    `**泄漏自检**：${leaks.length === 0 ? '通过' : `未通过（${leaks.length} 项）`}`,
    '',
    `**本章允许出场**：${packet.task.cast.join('、') || '（未限制）'}`,
    '',
    `**投影后的角色列表**`,
    ''
  )
  for (const c of packet.cast) {
    md.push(`- ${c.name}${c.role ? `（${c.role}）` : ''}：${c.identity || '—'}`)
  }
  md.push('', '**实际提示词**', '', '```text', rendered, '```', '')
}

const out = path.join(outDir, 'writer-packet-demo-new-format.md')
fs.writeFileSync(out, md.join('\n'), 'utf8')

console.log('已生成:', out)
console.log('')
console.log('关键差异（第 1 章 vs 第 8 章）：')
const p1 = buildWriterPacket(project, 1)
const p8 = buildWriterPacket(project, 8)
console.log('  第 1 章出场人物数:', p1.cast.length, '→', p1.cast.map((c) => c.name).join('、'))
console.log('  第 8 章出场人物数:', p8.cast.length, '→', p8.cast.map((c) => c.name).join('、'))
console.log('  秘密是否出现在第 8 章:', renderWriterPacket(p8).includes('伪造的死亡记录'))
