#!/usr/bin/env node
/**
 * 创书自动填充端到端验证（零成本：用假模型替身，不碰真实 API）。
 *
 * 目的：钉死「开书时未填的文风/世界观到底有没有被自动补齐」。
 * 做法：
 *   1) 备份 mobi/data/config.json 与 data/projects/，指向本机假模型；
 *   2) 起一个 OpenAI 兼容的假模型，返回**含 worldview/style** 的合法大纲 JSON；
 *   3) 走真实 HTTP POST /api/projects（与前端 Create 页完全同一条路）；
 *   4) 直接读落盘 JSON，断言字段；再跑一次「模型不返回 worldview」的对照；
 *   5) 无论成败，恢复备份、杀进程。
 *
 * 用法：node .wb-tmp/create-fill-check.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBI = path.resolve(__dirname, '..')
const ROOT = path.resolve(MOBI, '..')
const DATA = path.join(MOBI, 'data')
const CONFIG = path.join(DATA, 'config.json')
const PROJECTS = path.join(DATA, 'projects')
const BACKUP = path.join(ROOT, '.wb-tmp', '_data-backup')

const MOCK_PORT = 9911
const APP_PORT = 8799

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------- 假大纲（可控是否含 worldview） ------------------------- */
function outlineJSON({ withWorldview = true } = {}) {
  return JSON.stringify({
    title: '雨信十年',
    logline: '主角收到十年后的信',
    readerLogline: '一封来自未来的信改变了少年',
    readerTheme: '时间与选择',
    theme: '时间与选择',
    ...(withWorldview
      ? { worldview: '故事发生在一座终年多雨的临江小城，档案局与钟楼是全城地标；居民信奉「信必达」的旧规矩。' }
      : {}),
    style: '第三人称限知；短句为主，冷硬克制；意象集中在雨、纸、钟声。',
    preferences: {
      coreGoal: '查明十年前那封信究竟是谁寄出的',
      forbidden: '不写穿越；不出现系统面板；不用第二人称',
      ending: '开放式结局，偏向与母亲和解',
      protagonist: '沉默固执的档案局临时工，从逃避真相到主动承担',
    },
    acts: [
      { name: '第一幕', summary: '收到信', function: '建立悬念' },
      { name: '第二幕', summary: '追查来源', function: '冲突升级' },
      { name: '第三幕', summary: '面对真相', function: '收束' },
    ],
    cast: [
      { name: '林砚', publicRole: '档案局临时工', publicIdentity: '十九岁，沉默寡言，总带着旧伞',
        authorRole: '主角', secret: '他是十年前的寄信人', want: '查清真相', fear: '失去母亲',
        gender: '男', age: '19', appearance: '瘦高，旧伞', personality: '克制固执',
        motivation: '寻找真相', arc: '从逃避到承担', relationships: [], abilities: '无',
        status: '健康', highlight: '与母亲和解' },
    ],
    reveals: [],
    foreshadows: [
      { id: 'f1', seed: '信封上的水渍', payoff: '这是十年前那场大水的痕迹', plantAt: 1, revealAt: 4 },
    ],
    volumes: [
      { title: '卷一 雨季', goal: '建立谜题',
        chapters: Array.from({ length: 5 }, (_, i) => ({
          title: `雨信${i + 1}`, summary: `第${i + 1}章作者侧情节`, writerSummary: '林砚追查信件来源',
          writerGoal: '取得一条新线索', goal: '发现一个变化', cast: ['林砚'],
          foreshadows: i === 0 ? [{ id: 'f1', action: 'plant' }] : [],
        })) },
    ],
  })
}

/* --------------------------------- 假模型服务 -------------------------------- */
function startMock() {
  let mode = { withWorldview: true, thinOutline: false }
  let callCount = 0
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      callCount += 1
      // thinOutline：大纲那一次故意漏掉 worldview/style/preferences，
      // 逼出「设定兜底补全」那次调用；补全调用（含「设定师」字样）正常返回。
      const isFill = /设定师/.test(body)
      let content
      if (mode.thinOutline && !isFill) {
        const o = JSON.parse(outlineJSON({ withWorldview: false }))
        delete o.style; delete o.preferences
        content = JSON.stringify(o)
      } else if (isFill) {
        content = JSON.stringify({
          worldview: '兜底生成的世界观：终年多雨的临江小城。',
          style: '兜底生成的文风：第三人称限知，短句克制。',
          preferences: { coreGoal: '兜底核心目标', forbidden: '兜底禁令一；兜底禁令二', ending: '兜底结局', protagonist: '兜底主角' },
        })
      } else {
        content = outlineJSON(mode)
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', model: 'mock',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 1200, completion_tokens: 900, total_tokens: 2100 },
      }))
    })
  })
  return { srv, setMode: (m) => { mode = { ...mode, ...m }; callCount = 0 }, calls: () => callCount }
}

/* --------------------------------- HTTP 小工具 -------------------------------- */
function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload))
    const req = http.request({
      host: '127.0.0.1', port: APP_PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }) }
        catch { resolve({ status: res.statusCode, json: null, raw: b.slice(0, 300) }) }
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

/* ----------------------------------- 主流程 ---------------------------------- */
let mock, app
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve() })
        r.on('error', reject); r.setTimeout(500, () => r.destroy(new Error('timeout')))
      })
      return true
    } catch { await sleep(250) }
  }
  return false
}

async function main() {
  // 1) 备份
  fs.rmSync(BACKUP, { recursive: true, force: true })
  fs.mkdirSync(path.join(BACKUP, 'projects'), { recursive: true })
  if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, path.join(BACKUP, 'config.json'))
  for (const f of fs.readdirSync(PROJECTS)) fs.copyFileSync(path.join(PROJECTS, f), path.join(BACKUP, 'projects', f))
  log(`已备份：config.json + ${fs.readdirSync(PROJECTS).length} 个作品`)

  // 2) 指向假模型
  fs.writeFileSync(CONFIG, JSON.stringify({
    baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock', apiKey: 'mock-key', thinking: false,
  }, null, 2))

  mock = startMock()
  await new Promise((r) => mock.srv.listen(MOCK_PORT, '127.0.0.1', r))
  log(`假模型已起 :${MOCK_PORT}`)

  app = spawn(process.execPath, [path.join(MOBI, 'server', 'index.js')], {
    cwd: MOBI, env: { ...process.env, PORT: String(APP_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stderr.on('data', (d) => process.stderr.write('[app] ' + d))
  const up = await waitPort(APP_PORT)
  if (!up) throw new Error('后端未启动')
  log(`后端已起 :${APP_PORT}\n`)

  /* ============ 用例 A：用户没填世界观/文风，模型返回了两者 ============ */
  log('【A】用户只给灵感 + 题材，没填世界观/文风（模型返回了世界观与文风）')
  mock.setMode({ withWorldview: true })
  const a = await post('/api/projects', {
    idea: '主角在雨夜收到来自十年后的信', genre: '悬疑', genreTags: ['悬疑', '都市'],
    targetChapters: 5, preferences: {},
  })
  check('A: 创书成功', a.status === 200 && a.json?.project, `HTTP ${a.status} ${a.json?.error || ''}`)
  if (a.json?.project) {
    const p = a.json.project
    log(`      title=${p.title}｜status=${p.status}`)
    check('A: 世界观已自动补齐', String(p.authorWorldRules || '').trim().length > 0,
      `authorWorldRules=${JSON.stringify(p.authorWorldRules || '')}`)
    check('A: outline.style 有值', String(p.outline?.style || '').trim().length > 0)
    check('A: outline.worldview 有值', String(p.outline?.worldview || '').trim().length > 0)
    // 作者偏好四项：模型在大纲里给了就该落盘
    check('A: 核心目标已补', String(p.preferences?.coreGoal || '').trim().length > 0,
      `coreGoal=${JSON.stringify(p.preferences?.coreGoal || '')}`)
    check('A: 禁止描写已补', String(p.preferences?.forbidden || '').trim().length > 0)
    check('A: 结局偏好已补', String(p.preferences?.ending || '').trim().length > 0)
    check('A: 主角设定已补', String(p.preferences?.protagonist || '').trim().length > 0)
    check('A: 没填文风 ⇒ 模型文风回填到 styleSpec（抽屉读得到）',
      String(p.preferences?.styleSpec || '').trim().length > 0,
      `styleSpec=${JSON.stringify(p.preferences?.styleSpec || '')}`)
  }

  /* ============ 用例 B：用户填了文风（走 Create 页真实字段名 style） ============ */
  log('\n【B】用户填了「文风」（前端 Create 页真实发送 preferences.style）')
  const userStyle = '第一人称限知，短句＋吐槽节奏'
  const b = await post('/api/projects', {
    idea: '樱花池畔的观察部', genre: '都市', genreTags: ['都市', '轻松'],
    targetChapters: 5, preferences: { style: userStyle },
  })
  check('B: 创书成功', b.status === 200 && b.json?.project, `HTTP ${b.status} ${b.json?.error || ''}`)
  if (b.json?.project) {
    const p = b.json.project
    check('B: 用户文风已落盘 preferences.style', p.preferences?.style === userStyle,
      JSON.stringify(p.preferences || {}))
    // 抽屉「设置 → 文风设定」读的是 preferences.styleSpec
    check('B: 抽屉读得到文风（preferences.styleSpec 有值）',
      String(p.preferences?.styleSpec || '').trim().length > 0,
      `preferences.styleSpec=${JSON.stringify(p.preferences?.styleSpec || '')}`)
    check('B: 世界观未被用户文风顶掉（仍自动补齐）',
      String(p.authorWorldRules || '').trim().length > 0)
  }

  /* ============ 用例 C：模型不返回 worldview ⇒ 兜底补上 ============ */
  log('\n【C】模型不返回 worldview ⇒ 兜底补齐')
  mock.setMode({ withWorldview: false, thinOutline: false })
  const c = await post('/api/projects', {
    idea: '一座没有海的城市', genre: '科幻', genreTags: ['科幻'], targetChapters: 5, preferences: {},
  })
  check('C: 创书成功', c.status === 200 && c.json?.project, `HTTP ${c.status} ${c.json?.error || ''}`)
  if (c.json?.project) {
    const p = c.json.project
    check('C: 缺世界观时兜底补齐', String(p.authorWorldRules || '').includes('兜底生成的世界观'),
      `authorWorldRules=${JSON.stringify(p.authorWorldRules || '')}`)
  }

  /* ============ 用例 D：大纲模型偷懒漏填 ⇒ 兜底补全那次调用被触发 ============ */
  log('\n【D】大纲模型漏填世界观/文风/偏好 ⇒ 触发设定兜底补全')
  mock.setMode({ withWorldview: true, thinOutline: true })
  const d = await post('/api/projects', {
    idea: '一份没有署名的档案', genre: '悬疑', genreTags: ['悬疑'], targetChapters: 5, preferences: {},
  })
  check('D: 创书成功', d.status === 200 && d.json?.project, `HTTP ${d.status} ${d.json?.error || ''}`)
  check('D: 触发了一次额外补全调用（共 2 次）', mock.calls() === 2, `实际 ${mock.calls()} 次`)
  if (d.json?.project) {
    const p = d.json.project
    check('D: 世界观由兜底补齐', String(p.authorWorldRules || '').includes('兜底生成的世界观'),
      `authorWorldRules=${JSON.stringify(p.authorWorldRules || '')}`)
    check('D: 文风由兜底补齐到 styleSpec', String(p.preferences?.styleSpec || '').includes('兜底生成的文风'))
    check('D: 核心目标由兜底补齐', p.preferences?.coreGoal === '兜底核心目标')
    check('D: 禁止描写由兜底补齐', String(p.preferences?.forbidden || '').includes('兜底禁令'))
    check('D: 结局偏好由兜底补齐', p.preferences?.ending === '兜底结局')
    check('D: 主角设定由兜底补齐', p.preferences?.protagonist === '兜底主角')
  }

  /* ============ 用例 E：设定已齐全 ⇒ 不该多花一次调用 ============ */
  log('\n【E】大纲模型已给全设定 ⇒ 不应触发补全')
  mock.setMode({ withWorldview: true, thinOutline: false })
  const e = await post('/api/projects', {
    idea: '开满樱花的旧校舍', genre: '都市', genreTags: ['都市'], targetChapters: 5, preferences: {},
  })
  check('E: 创书成功', e.status === 200 && e.json?.project, `HTTP ${e.status} ${e.json?.error || ''}`)
  check('E: 只调用了 1 次模型（未浪费补全）', mock.calls() === 1, `实际 ${mock.calls()} 次`)
}

try {
  await main()
} catch (e) {
  log('\n[异常]', e.message)
  results.push({ name: '执行异常', ok: false, detail: e.message })
} finally {
  try { app?.kill() } catch {}
  try { mock?.srv?.close() } catch {}
  await sleep(400)
  // 恢复数据
  if (fs.existsSync(path.join(BACKUP, 'config.json'))) fs.copyFileSync(path.join(BACKUP, 'config.json'), CONFIG)
  fs.rmSync(PROJECTS, { recursive: true, force: true })
  fs.mkdirSync(PROJECTS, { recursive: true })
  const bp = path.join(BACKUP, 'projects')
  for (const f of fs.readdirSync(bp)) fs.copyFileSync(path.join(bp, f), path.join(PROJECTS, f))
  fs.rmSync(BACKUP, { recursive: true, force: true })
  log(`\n已恢复原始数据（作品 ${fs.readdirSync(PROJECTS).length} 个）`)

  const pass = results.filter((r) => r.ok).length
  log(`\n===== 结果 ${pass}/${results.length} =====`)
  for (const r of results) if (!r.ok) log(`  FAIL: ${r.name} ${r.detail}`)
  process.exit(0)
}
