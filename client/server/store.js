/**
 * Repository 层：项目与配置的持久化。
 *
 * 当前实现为 JSON 文件存储（零依赖、可靠），对外暴露的接口按「仓储」抽象，
 * 后续按工程规划文档 §5 升级到 SQLite 时只需替换本文件内部实现，调用方不动。
 *
 * v2 起：读取到未迁移的旧数据时，会**先备份原文件、再就地迁移**（幂等，可重复）。
 * 迁移逻辑见 migrate.js —— 全程不调用模型，不伪造出处。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SCHEMA_VERSION, emptyLedger, validateProject } from './schema.js'
import { migrateProject } from './migrate.js'
import { initialPreferences } from './author-control.js'
import { normalizeGenreTags, primaryGenre, validateChapterCount, DEFAULT_CHAPTERS } from './creative-options.js'
import { usageSummary } from './cost.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')
/**
 * 数据目录。默认 `<项目>/data`，可用 `MOBI_DATA_DIR` 覆盖。
 *
 * ⚠️ 这个覆盖开关是**测试隔离**的必需品，不是可选项：
 * 真实踩坑（v2.0.0 期间）：`tests/backend-shim.test.js` 为了验证 `publicConfig()`
 * 不泄露密钥，直接调了**真实** store 的 `saveConfig({apiKey:'sk-secret-…'})`
 * —— 而那时 DATA_DIR 硬编码指向 `mobi/data`。`saveConfig` 是「读现有 → 合并 → 写回」，
 * 于是**真实密钥被整条覆盖成测试占位符**，表现为所有模型调用突然 401。
 * 排查时还会误以为是「密钥泄露被官方禁用」（DeepSeek 的报错正好也是这个口径）。
 * ⇒ 测试进程必须在 import 本模块**之前**把 MOBI_DATA_DIR 指到临时目录。
 * （与 MOBI_TOKEN / MOBI_API_KEY / MOBI_BASE_URL 同属一套环境变量覆盖约定。）
 */
const DATA_DIR = process.env.MOBI_DATA_DIR
  ? path.resolve(process.env.MOBI_DATA_DIR)
  : path.join(ROOT, 'data')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
// 备份目录默认是数据目录的**兄弟**（`mobi/.backups` 对应 `mobi/data`）；
// 覆盖数据目录时同样跟随，保证测试不会写进真实备份。
const BACKUP_DIR = path.join(path.dirname(DATA_DIR), '.backups')
const RUN_DIR = path.join(DATA_DIR, 'runs')

function ensureDirs() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true })
}

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// 原子写入：先落临时文件再改名，避免中断产生半截文件
function writeJSON(file, data) {
  ensureDirs()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function newId(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

/* -------------------------------- 访问令牌 -------------------------------- */
/**
 * 局域网访问口令。
 * 本机（127.0.0.1）免检；其他设备必须携带此口令，避免同一 WiFi 下
 * 任意设备读取作品、改写配置或触发付费生成。
 * 持久化在 data/access-token.txt，可用环境变量 MOBI_TOKEN 覆盖。
 */
const TOKEN_FILE = path.join(DATA_DIR, 'access-token.txt')

export function getAccessToken() {
  if (process.env.MOBI_TOKEN) return String(process.env.MOBI_TOKEN)
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (saved) return saved
  } catch {
    /* 首次运行，下面生成 */
  }
  const token = crypto.randomBytes(16).toString('hex')
  ensureDirs()
  fs.writeFileSync(TOKEN_FILE, token, 'utf8')
  return token
}

/* ---------------------------------- 配置 ---------------------------------- */

// 默认指向 DeepSeek 当前主力模型 V4.1-Flash（模型 ID 就叫 deepseek-flash）
const DEFAULT_CONFIG = {
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
}

export function getConfig() {
  const saved = readJSON(CONFIG_FILE, {}) || {}
  return {
    baseURL: saved.baseURL || process.env.MOBI_BASE_URL || DEFAULT_CONFIG.baseURL,
    model: saved.model || process.env.MOBI_MODEL || DEFAULT_CONFIG.model,
    apiKey: saved.apiKey || process.env.MOBI_API_KEY || '',
    temperature: typeof saved.temperature === 'number' ? saved.temperature : 0.9,
    // 深度思考默认关闭：思考 token 按输出计费，长篇逐章生成会显著推高成本
    thinking: saved.thinking === true,
    pricing: saved.pricing || null,
    chapterBudget: saved.chapterBudget ?? null,
    maxChapterTokens: saved.maxChapterTokens ?? null,
    inputBudget: saved.inputBudget ?? 10000,
    replanBudget: saved.replanBudget ?? null,
  }
}

export function saveConfig(patch = {}) {
  const saved = readJSON(CONFIG_FILE, {}) || {}
  const next = { ...saved }
  for (const [k, v] of Object.entries(patch)) {
    // 可选的预算、单价允许显式传 null 清空；undefined 仍表示“不修改”。
    // 避免用户在设置页删除预算后，磁盘依然保留旧的消费限制。
    if (v === undefined) continue
    if (v === null && !['pricing', 'chapterBudget', 'maxChapterTokens', 'replanBudget'].includes(k)) continue
    next[k] = v
  }
  writeJSON(CONFIG_FILE, next)
  return getConfig()
}

/** 给前端看的配置：绝不含明文密钥 */
export function publicConfig() {
  const c = getConfig()
  return {
    baseURL: c.baseURL,
    model: c.model,
    hasKey: Boolean(c.apiKey),
    keyTail: c.apiKey ? c.apiKey.slice(-4) : '',
    thinking: c.thinking,
    pricing: c.pricing,
    chapterBudget: c.chapterBudget,
    maxChapterTokens: c.maxChapterTokens,
    inputBudget: c.inputBudget,
    replanBudget: c.replanBudget,
  }
}

/* ---------------------------------- 项目 ---------------------------------- */

function projectFile(id) {
  return path.join(PROJECTS_DIR, `${id}.json`)
}

function plannedCount(p) {
  if (p?.outline?.totalChapters) return p.outline.totalChapters
  const vs = p?.outline?.volumes || []
  return vs.reduce((n, v) => n + (v.chapters?.length || 0), 0)
}

/** 迁移前的文件级备份，失败可手工回滚 */
function backupBeforeMigrate(id) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(BACKUP_DIR, `${id}.pre-v${SCHEMA_VERSION}.${stamp}.json`)
    fs.copyFileSync(projectFile(id), dest)
    return dest
  } catch (err) {
    console.error('[store] 迁移前备份失败：', err)
    return null
  }
}

export function listProjects() {
  ensureDirs()
  // 包括失败/取消的模型调用：费用按实际可得 usage 汇总，不仅计算定稿章节。
  const runs = listRuns()
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(PROJECTS_DIR, f)))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status || (p.outline?.volumes?.length ? 'ready' : 'outline_failed'),
      idea: p.idea,
      genre: p.genre,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      schemaVersion: p.schemaVersion || 1,
      targetChapters: p.targetChapters || null,
      chapterCount: (p.chapters || []).length,
      plannedCount: plannedCount(p),
      usage: (() => {
        const old = p.usage || {}
        const byRun = usageSummary(runs.filter((r) => r.projectId === p.id).flatMap((r) => r.usage || []), getConfig().pricing)
        return {
          calls: Number(old.calls || 0) + byRun.calls,
          inputTokens: Number(old.inputTokens || 0) + byRun.inputTokens,
          outputTokens: Number(old.outputTokens || 0) + byRun.outputTokens,
          reasoningTokens: Number(old.reasoningTokens || 0) + byRun.reasoningTokens,
          cachedInputTokens: byRun.cachedInputTokens,
          runCost: byRun.estimatedCost,
        }
      })(),
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

/**
 * 读取项目。若为未迁移的旧数据（或需要补 v2 内部新增字段），先备份再就地升级。
 *
 * 注意：这里**每次读取都会问一次「需不需要升级」**，而不是只看 schemaVersion。
 * 原因是 R1 新增了 trust / 伏笔 ID 这类有运行后果的字段，它们的缺失同样是
 * 需要修复的状态；只判断版本号会让老数据永远停在「缺字段但版本看起来没问题」。
 */
export function getProject(id) {
  if (!id || !/^[\w-]+$/.test(id)) return null
  const raw = readJSON(projectFile(id), null)
  if (!raw) return null

  const result = migrateProject(raw)
  if (!result.changed) return raw

  const backup = backupBeforeMigrate(id)
  try {
    writeJSON(projectFile(id), result.project)
    console.log(`[store] ${id} 已升级：${result.notes.join('；')}${backup ? `（备份：${backup}）` : ''}`)
    return result.project
  } catch (err) {
    console.error('[store] 数据升级失败，返回原始数据：', err)
    return raw
  }
}

/**
 * 保存项目。
 *
 * 写入前跑结构校验 —— 第 2 轮评审附注：「Schema 存在不等于业务写入已经受到
 * Schema 约束」。此前 validateProject 只在迁移脚本里被调用，生成与保存路径
 * 完全不校验，等于形同虚设。
 *
 * 行为：校验结果写入 project.lastValidation 并输出日志；
 * 默认不阻断（旧数据可能暂时不合规，不应因一次校验失败丢用户作品），
 * 传 { strict: true } 则直接抛错 —— 迁移等关键路径用严格模式。
 */
export function saveProject(project, { strict = false } = {}) {
  const issues = validateProject(project)
  project.lastValidation = {
    at: new Date().toISOString(),
    ok: issues.length === 0,
    count: issues.length,
    issues: issues.slice(0, 20),
  }
  if (issues.length) {
    console.warn(
      `[store] ${project.id} 结构校验发现 ${issues.length} 个问题：${issues.slice(0, 3).join('；')}`
    )
    if (strict) {
      throw new Error(`项目结构校验未通过：${issues.slice(0, 3).join('；')}`)
    }
  }
  project.updatedAt = new Date().toISOString()
  writeJSON(projectFile(project.id), project)
  return project
}

/**
 * 删除作品 —— **先备份，再删**。
 *
 * ⛔ 原来是直接 `unlinkSync`：作品本体与它的全部修改请求（里面可能有作者私密设定）
 *    当场消失、**无法撤销**；而 `data/` 里其它东西（runs / changes）都还留着可追查的痕迹，
 *    偏偏最贵的那份（作品本体）没有任何兜底。
 *
 * 现在的语义：整批搬进 `data/trash/<id>-<时间戳>/`（人工可恢复），
 * 并且**备份失败就取消删除** —— 宁可删不掉，也不能悄悄丢数据。
 *
 * @returns {{ok:boolean, backup?:string, changeCount?:number, reason?:string}}
 */
export function deleteProject(id) {
  if (!id || !/^[\w-]+$/.test(id)) return { ok: false, reason: '作品 ID 非法' }
  const file = projectFile(id)
  if (!fs.existsSync(file)) return { ok: false, reason: '作品不存在' }
  const changes = listChanges(id)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(path.dirname(file), 'trash', `${id}-${stamp}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(file, path.join(dir, 'project.json'))
    let copied = 0
    for (const change of changes) {
      try {
        fs.copyFileSync(path.join(CHANGE_DIR, `${change.id}.json`), path.join(dir, `${change.id}.json`))
        copied += 1
      } catch { /* 单条请求拷不动不阻断整批备份 */ }
    }
    fs.writeFileSync(path.join(dir, 'README.txt'),
      `这是作品 ${id} 的删除备份（${new Date().toISOString()}）。\n`
      + `project.json 是删除前的完整作品；其余文件是它的修改请求（可能含作者私密设定）。\n`
      + `要恢复：把 project.json 复制回 data/projects/${id}.json 即可。\n`, 'utf8')
    try {
      fs.unlinkSync(file)
      for (const change of changes) {
        try { fs.unlinkSync(path.join(CHANGE_DIR, `${change.id}.json`)) } catch { /* 忽略已清除的请求 */ }
      }
      return { ok: true, backup: dir, changeCount: copied }
    } catch (e) {
      return { ok: false, reason: `删除失败（备份仍保留在 ${dir}）：${e?.message || e}` }
    }
  } catch (e) {
    return { ok: false, reason: `备份失败，已取消删除：${e?.message || e}` }
  }
}

export function createProjectBase({ idea, genre, genreTags, targetChapters = DEFAULT_CHAPTERS, preferences = {} }) {
  const now = new Date().toISOString()
  return {
    id: newId(),
    schemaVersion: SCHEMA_VERSION,
    headVersion: 0,
    editRevision: 0,
    createdAt: now,
    updatedAt: now,
    title: '',
    status: 'outline_pending',
    outlineError: null,
    idea,
    genre: primaryGenre(genreTags, genre || '玄幻'),
    genreTags: normalizeGenreTags(genreTags, genre || '玄幻'),
    ...initialPreferences(preferences),
    // 章节规模由用户决定；规划器据此分配卷数与每卷章数
    targetChapters: validateChapterCount(targetChapters),
    outline: null,
    chapters: [],
    entities: [],
    ledger: emptyLedger(),
    migrations: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  }
}


/* -------------------------- R4 持久化生成任务 -------------------------- */
/**
 * Run 记录独立于正式作品存储：联网写作中断后也能查看已花费 token 与草稿。
 * 保存顺序是：先落 run 草稿 → 正式项目 CAS 提交 → run 标记 committed。
 */
export function getRun(id) {
  if (!/^run_[0-9a-f]{24}$/.test(String(id || ''))) return null
  return readJSON(path.join(RUN_DIR, `${id}.json`), null)
}

export function saveRun(run) {
  if (!/^run_[0-9a-f]{24}$/.test(String(run?.id || ''))) throw new Error('非法任务 ID')
  fs.mkdirSync(RUN_DIR, { recursive: true })
  writeJSON(path.join(RUN_DIR, `${run.id}.json`), run)
  return run
}

export function listRuns(projectId = null) {
  if (!fs.existsSync(RUN_DIR)) return []
  return fs.readdirSync(RUN_DIR).filter((f) => /^run_[0-9a-f]{24}\.json$/.test(f))
    .map((f) => readJSON(path.join(RUN_DIR, f), null))
    // AI 助手的 proposed 是编辑建议，并不是活跃的章节/重排模型任务。
    // 章节工作流使用 listRuns(projectId) 做并发互斥，若把助手提议算进去，
    // 用户不回复就再也不能继续生成正文；不带 projectId 的全量用量统计仍包含助手请求。
    .filter((r) => r && (!projectId || (r.projectId === projectId && !String(r.type || '').startsWith('assistant'))))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

/**
 * 单进程同步比较并写入：临界区内没有 await，中间不会插入另一次 Node 请求。
 * 不承诺多个独立服务器进程共享同一 JSON 目录的并发安全。
 */
export function commitProjectVersion(next, expectedHeadVersion, expectedEditRevision = null) {
  const current = readJSON(projectFile(next.id), null)
  if (!current || Number(current.headVersion || 0) !== Number(expectedHeadVersion)) {
    throw new Error('项目版本冲突：磁盘 head 已改变，拒绝覆盖')
  }
  if (expectedEditRevision != null && Number(current.editRevision || 0) !== Number(expectedEditRevision)) throw new Error('项目规划修订版本冲突')
  if (Number(next.headVersion || 0) !== Number(expectedHeadVersion) + 1) {
    throw new Error('错误的提交版本号')
  }
  return saveProject(next, { strict: true })
}


/** 不推进剧情 head，只修改规划版本；必须和冻结基线一致。 */
export function commitProjectEdit(next, expectedHeadVersion, expectedEditRevision) {
  const current = readJSON(projectFile(next.id), null)
  if (!current || Number(current.headVersion || 0) !== Number(expectedHeadVersion) ||
      Number(current.editRevision || 0) !== Number(expectedEditRevision) ||
      Number(next.editRevision || 0) !== Number(expectedEditRevision) + 1) {
    throw new Error('重排提交版本冲突，禁止覆盖')
  }
  return saveProject(next, { strict: true })
}


/* -------------------------- 作者修改请求独立持久化 -------------------------- */
const CHANGE_DIR = path.join(DATA_DIR, 'changes')
export function getChange(id) {
  if (!/^cr_[0-9a-f]{24}$/.test(String(id || ''))) return null
  return readJSON(path.join(CHANGE_DIR, `${id}.json`),null)
}
export function saveChange(change) {
  if (!/^cr_[0-9a-f]{24}$/.test(String(change?.id || ''))) throw new Error('非法修改请求 ID')
  fs.mkdirSync(CHANGE_DIR,{recursive:true})
  writeJSON(path.join(CHANGE_DIR, `${change.id}.json`),change)
  return change
}
export function listChanges(projectId) {
  if (!/^[\w-]+$/.test(String(projectId||''))) return []
  if (!fs.existsSync(CHANGE_DIR)) return []
  return fs.readdirSync(CHANGE_DIR).filter(f=>/^cr_[0-9a-f]{24}\.json$/.test(f))
    .map(f=>readJSON(path.join(CHANGE_DIR,f),null)).filter(r=>r?.projectId===projectId)
    .sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))
}
