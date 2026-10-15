/**
 * R3 迁移/验收脚本：
 *   node scripts/r3-upgrade.mjs [作品ID]
 *   node scripts/r3-upgrade.mjs [作品ID] --assist
 *   node scripts/r3-upgrade.mjs [作品ID] --approve review.json --reviewer owner
 *
 * 默认完全离线，模型建议永远以 needsReview 入库；--approve 是用户明确审核的入口。
 * 有 --assist 才允许消耗 API 配额，且必须用户事先配置密钥。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateProject } from '../server/migrate.js'
import { ensureForeshadowStore, normalizeForeshadows, suggestLegacyLinks, importLinkProposals, makeLinkAssistantPacket } from '../server/foreshadow.js'
import { recoverLiteralLegacyRecords, recoverVerbatimObservations, recoveryReport, makeEvidenceCandidates } from '../server/recovery.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const id = process.argv[2] || 'p_64d57c208eb4'
if (!/^[\w-]+$/.test(id)) throw new Error('非法作品 ID')
const dest = path.join(root, 'data', 'projects', id + '.json')
const original = JSON.parse(fs.readFileSync(dest, 'utf8'))
const migrated = migrateProject(original).project
const p = structuredClone(migrated)
normalizeForeshadows(p)
ensureForeshadowStore(p)

const literal = recoverLiteralLegacyRecords(p)
const observationQuotes = id === 'p_64d57c208eb4' ? [
  '米白色，牛皮纸，很厚实，没有邮戳，没有寄件人地址。',
  '收件人那一栏写着他的名字。沈砚。',
  '那本登记簿的编号他认得。是十年前的入库记录。',
  '左手腕上那道旧疤在凉空气里隐隐发痒',
  '他把信折好，放回信封，塞进公文包最里层的夹袋',
  '信不放在家里了。',
] : []
const observations = recoverVerbatimObservations(p, observationQuotes)
const candidates = suggestLegacyLinks(p)
const assist = process.argv.includes('--assist')
const approvedFilePos = process.argv.indexOf('--approve')
let modelResult = null
if (assist) {
  // 高权限规划模型可读取作者真相；返回结果仅作为未审核的候选计划。
  const { chat } = await import('../server/providers/openai.js')
  const { getConfig } = await import('../server/store.js')
  const cfg = getConfig()
  if (!cfg.apiKey) throw new Error('--assist 需要先在设置页配置 API Key；本次没有调用模型。')
  const result = await chat({ ...cfg, messages: [
    { role: 'system', content: '你是作者侧伏笔规划器。请检查文本语义关联，输出 {"links":[{"foreshadowId":"...","plantChapter":1,"payoffChapter":26,"evidence":"为何这样关联","confidence":0.7}]}。不确定填 null。只提供计划候选，不声明正文已经发生。' },
    { role: 'user', content: JSON.stringify(makeLinkAssistantPacket(p)) },
  ], jsonMode: true, maxTokens: 3000, temperature: 0, thinking: false, timeoutMs: 120000 })
  modelResult = JSON.parse(String(result.text).replace(/^```(?:json)?\s*/,'').replace(/```\s*$/,''))
  importLinkProposals(p, modelResult.links || [], { reviewed: false })
}
if (approvedFilePos !== -1) {
  const filepath = process.argv[approvedFilePos + 1]
  const reviewerPos = process.argv.indexOf('--reviewer')
  if (!filepath || reviewerPos < 0 || !process.argv[reviewerPos + 1]) throw new Error('审核需要 --approve review.json --reviewer owner')
  const reviewedLinks = JSON.parse(fs.readFileSync(filepath, 'utf8'))
  const proposals = Array.isArray(reviewedLinks) ? reviewedLinks : reviewedLinks.links
  importLinkProposals(p, proposals, { reviewed: true, reviewer: process.argv[reviewerPos + 1] })
}
// 原文件的备份与改写必须成对执行；备份内容不带密钥。
const before = JSON.stringify(original)
const after = JSON.stringify(p)
if (before !== after) {
  const backup = path.join(root, 'data', 'projects', `${id}.pre-r3.bak`)
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(original, null, 2))
  const temp = dest + '.r3.tmp'
  fs.writeFileSync(temp, JSON.stringify(p, null, 2))
  fs.renameSync(temp, dest)
}
const docs = path.join(root, 'docs')
fs.mkdirSync(docs, { recursive: true })
const report = { id, literal, observations, recovered: recoveryReport(p), proposedLinks: candidates,
  modelSuggestions: modelResult?.links || [], evidenceCandidates: makeEvidenceCandidates(p),
  note: '模型/文本匹配的伏笔计划仍为 needsReview；正文未写到的计划不等于实际铺设或回收。' }
fs.writeFileSync(path.join(docs, `R3_迁移与待审核清单_${id}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ id, ...report.recovered, observations: observations.restored.length,
  pendingLinks: p.outline?.foreshadows?.filter((f) => f.linkStatus === 'needsReview').length,
  report: `docs/R3_迁移与待审核清单_${id}.json` }, null, 2))
