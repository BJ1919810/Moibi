/**
 * 数据迁移脚本：把 data/projects 下的旧格式作品迁移到 schema v2。
 *
 * 用法：
 *   node scripts/migrate-data.mjs --dry-run   # 只预演，不写盘
 *   node scripts/migrate-data.mjs             # 实际迁移（迁移前自动备份原文件）
 *
 * 特性：幂等（已迁移的跳过）、失败不影响原文件、逐项打印前后对比。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateProject } from '../server/migrate.js'
import { validateProject, SCHEMA_VERSION } from '../server/schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PROJECTS = path.join(ROOT, 'data', 'projects')
const BACKUP = path.join(ROOT, '.backups')
const dryRun = process.argv.includes('--dry-run')

function summarize(p) {
  const ledger = p.ledger || {}
  const chapters = []
  for (const v of p.outline?.volumes || []) chapters.push(...(v.chapters || []))
  const withCast = chapters.filter((c) => (c.cast || []).length > 0).length
  return {
    schema: p.schemaVersion || 1,
    entities: (p.entities || []).length,
    facts: (ledger.canonicalFacts || []).length || (p.state?.facts || []).length,
    threads: (ledger.plotThreads || []).length || (p.state?.threads || []).length,
    chapters: chapters.length,
    chaptersWithCast: withCast,
    written: (p.chapters || []).length,
  }
}

function fmt(s) {
  return `schema=v${s.schema} 实体=${s.entities} 事实=${s.facts} 线索=${s.threads} 章节=${s.chapters}(有cast ${s.chaptersWithCast}) 已写=${s.written}`
}

if (!fs.existsSync(PROJECTS)) {
  console.log('没有 data/projects 目录，无需迁移')
  process.exit(0)
}

const files = fs.readdirSync(PROJECTS).filter((f) => f.endsWith('.json'))
console.log(`发现 ${files.length} 个作品文件${dryRun ? '（预演模式，不写盘）' : ''}`)
console.log('')

let migrated = 0
let skipped = 0

for (const f of files) {
  const file = path.join(PROJECTS, f)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`── ${raw.title || f}`)

  // 不只看版本号：migrateProject 内部会判断是否需要补 v2 新增的有运行后果的字段
  const probe = migrateProject(raw)
  if (!probe.changed) {
    console.log('   已经是目标版本，且无待补齐字段，跳过')
    skipped++
    continue
  }

  const before = summarize(raw)
  const { project, notes } = probe
  const after = summarize(project)

  console.log('   迁移前:', fmt(before))
  console.log('   迁移后:', fmt(after))
  for (const n of notes) console.log('     ·', n)

  const issues = validateProject(project)
  if (issues.length) {
    console.log('   ⚠ 校验问题:')
    for (const i of issues) console.log('     -', i)
  } else {
    console.log('   结构校验: 通过')
  }

  if (!dryRun) {
    fs.mkdirSync(BACKUP, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = path.join(BACKUP, `${raw.id}.pre-v${SCHEMA_VERSION}.${stamp}.json`)
    fs.copyFileSync(file, bak)
    fs.writeFileSync(file, JSON.stringify(project, null, 2), 'utf8')
    console.log('   已写盘，备份:', path.basename(bak))
  }
  migrated++
  console.log('')
}

console.log(`完成：迁移 ${migrated} 个，跳过 ${skipped} 个`)
