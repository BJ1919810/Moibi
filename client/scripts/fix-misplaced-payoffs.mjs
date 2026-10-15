#!/usr/bin/env node
/**
 * 一次性修复：把**历史遗留**的「回收章错位」降级。
 *
 * 背景（v2.0.0 第二轮全量压测，《风起处见线》真实付费 6 章）：
 *   模型把 `f3/pay_off` 排到第 7 章，而 f3 声明的回收章是第 16 章 —— 同批 9 条 pay_off 有 6 条错位。
 *   `revealDecision()` 判 `wrong-chapter` ⇒ 那些章在模型调用前就被拦死（¥0，但永远写不出来）。
 *
 * `replan.js` 的 `downgradeMisplacedPayoffs` 已在**新的**重排里生效，
 * 但**已经排好的历史数据**不会自己修 —— 这个脚本就是补那一刀。
 *
 * 安全性：
 *   · 只把**错位**章的 `pay_off` 改成 `reinforce`（`approved:true`，但 reinforce 不构成回收授权）；
 *   · **不改伏笔自己声明的回收章**（那是作者意图）；
 *   · 默认 **dry-run**，只打印；要真写必须显式 `--apply`。
 *
 * 用法：
 *   node scripts/fix-misplaced-payoffs.mjs --project p_xxx              # 预览
 *   node scripts/fix-misplaced-payoffs.mjs --project p_xxx --apply      # 真写（会先备份）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downgradeMisplacedPayoffs } from '../server/replan.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]
  if (!k.startsWith('--')) continue
  const key = k.slice(2)
  if (key === 'apply') { args.apply = true; continue }
  args[key] = process.argv[++i]
}
const pid = args.project
if (!pid) { console.error('用法：node scripts/fix-misplaced-payoffs.mjs --project p_xxx [--apply]'); process.exit(1) }

const file = path.join(ROOT, 'data', 'projects', `${pid}.json`)
if (!fs.existsSync(file)) { console.error(`作品不存在：${file}`); process.exit(1) }

const project = JSON.parse(fs.readFileSync(file, 'utf8'))
const decl = new Map((project.outline?.foreshadows || []).map((f) => [f.id, Number(f.payoffChapter ?? f.revealAt) || null]))

console.log(`作品：《${project.title}》 (${pid})`)
console.log(`已定稿：${(project.chapters || []).filter((c) => c.status === 'committed').length} 章`)
console.log()

// 找出所有错位
const misplaced = []
for (const v of project.outline?.volumes || []) {
  for (const c of v.chapters || []) {
    for (const a of c.foreshadows || []) {
      if (a.action !== 'pay_off') continue
      const want = decl.get(a.id)
      if (want && want !== c.no) misplaced.push({ chapterNo: c.no, id: a.id, want })
    }
  }
}

if (!misplaced.length) {
  console.log('✓ 没有发现「回收章错位」，无需修复。')
  process.exit(0)
}

console.log(`发现 ${misplaced.length} 条错位：`)
for (const m of misplaced) {
  console.log(`  第 ${m.chapterNo} 章 ${m.id}/pay_off  →  声明回收章是第 ${m.want} 章`)
}
console.log()

if (!args.apply) {
  console.log('（这是预览。要真正修复请加 --apply）')
  process.exit(0)
}

// 备份
const backupDir = path.join(ROOT, '.backups')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const backupFile = path.join(backupDir, `${pid}-prefix-misplaced-${stamp}.json`)
fs.writeFileSync(backupFile, JSON.stringify(project, null, 2))
console.log(`已备份 → ${path.relative(ROOT, backupFile)}`)

// 收集所有章节（拍平），交给共用函数就地降级
const chapters = (project.outline?.volumes || []).flatMap((v) => v.chapters || [])
const warnings = downgradeMisplacedPayoffs(chapters, project.outline, [])

fs.writeFileSync(file, JSON.stringify(project, null, 2))
console.log(`已修复 ${warnings.length} 条：`)
for (const w of warnings) console.log(`  · ${w}`)
console.log()
console.log('注意：降级后的动作是 reinforce（有 approved 但**不构成回收授权**），')
console.log('      伏笔自己声明的回收章一字未改。')
