/**
 * 导出指定章节的 WriterPacket —— 用于人工审查信息边界。
 *
 * 用法：
 *   node scripts/dump-writer-packet.mjs <projectId> <chapterNo> [输出目录]
 *
 * 产出两份文件：
 *   writer-packet-<id>-ch<no>.json  完整的 packet 结构（供逐字段核对）
 *   writer-packet-<id>-ch<no>.md    渲染后的正文提示词 + 泄漏自检结果
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from '../server/store.js'
import { buildWriterPacket, renderWriterPacket, findLeaks } from '../server/projection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const [, , id, noRaw, outDirRaw] = process.argv
if (!id || !noRaw) {
  console.error('用法：node scripts/dump-writer-packet.mjs <projectId> <chapterNo> [输出目录]')
  process.exit(1)
}

const no = Number(noRaw)
const project = store.getProject(id)
if (!project) {
  console.error('作品不存在：', id)
  process.exit(1)
}

const outDir = outDirRaw ? path.resolve(outDirRaw) : path.join(ROOT, 'docs')
fs.mkdirSync(outDir, { recursive: true })

const packet = buildWriterPacket(project, no)
const rendered = renderWriterPacket(packet)
const leaks = findLeaks(packet, project)

const base = `writer-packet-${id}-ch${no}`
const jsonPath = path.join(outDir, `${base}.json`)
const mdPath = path.join(outDir, `${base}.md`)

fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), 'utf8')

const lines = [
  `# WriterPacket 样例 · 第 ${no} 章`,
  '',
  `- 作品：${project.title}（${project.genre}）`,
  `- 生成时间：${new Date().toISOString()}`,
  `- packet schema 版本：${packet.schemaVersion}`,
  `- **泄漏自检：${leaks.length === 0 ? '通过（未发现敏感内容）' : `未通过，${leaks.length} 项`}**`,
  '',
]

if (leaks.length) {
  lines.push('## 泄漏项', '')
  for (const l of leaks) {
    lines.push(`- \`${l.type}\` @ ${l.target}：「${String(l.fragment).slice(0, 60)}」`)
  }
  lines.push('')
}

lines.push(
  '## 投影结果（结构化）',
  '',
  '```json',
  JSON.stringify(
    {
      work: packet.work,
      cast: packet.cast,
      task: packet.task,
      context: packet.context,
      constraints: packet.constraints,
    },
    null,
    2
  ),
  '```',
  '',
  '## 实际送往正文模型的提示词',
  '',
  '```text',
  rendered,
  '```',
  ''
)

fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')

console.log('packet  :', jsonPath)
console.log('提示词  :', mdPath)
console.log('泄漏自检:', leaks.length === 0 ? '通过' : `${leaks.length} 项未通过`)
for (const l of leaks) console.log('  -', l.type, '@', l.target, '→', String(l.fragment).slice(0, 40))
