#!/usr/bin/env node
/**
 * UI 验证：创作资料面板的 ☰ 导航键 + 「剧情方向修改」独立入口。
 * 零成本：用本机假模型 + 真 Edge + CDP 截图。
 * 用法：node .wb-tmp/shot-nav-direction.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBI = path.resolve(__dirname, '..')
const DIST = path.join(MOBI, 'dist')
const SHOTS = path.join(__dirname, 'shots')
const CONFIG = path.join(MOBI, 'data', 'config.json')
const PROJECTS = path.join(MOBI, 'data', 'projects')
const BACKUP = path.join(__dirname, '_data-backup2')

const WEB_PORT = 8791
const MOCK_PORT = 9912
const APP_PORT = 8792
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

function outlineJSON() {
  return JSON.stringify({
    title: '雨信十年', logline: '主角收到十年后的信', readerLogline: '一封来自未来的信',
    readerTheme: '时间与选择', theme: '时间与选择',
    worldview: '终年多雨的临江小城，档案局与钟楼是全城地标。',
    style: '第三人称限知；短句为主，冷硬克制。',
    preferences: { coreGoal: '查明信的来源', forbidden: '不写穿越；不出系统面板', ending: '开放式和解', protagonist: '沉默的档案员' },
    acts: [{ name: '第一幕', summary: '收到信', function: '建立悬念' },
      { name: '第二幕', summary: '追查', function: '升级' }, { name: '第三幕', summary: '真相', function: '收束' }],
    cast: [{ name: '林砚', publicRole: '档案局临时工', publicIdentity: '十九岁，沉默寡言', authorRole: '主角',
      secret: '他是寄信人', want: '查真相', fear: '失去母亲', gender: '男', age: '19', appearance: '瘦高',
      personality: '克制', motivation: '寻真相', arc: '从逃避到承担', relationships: [], abilities: '无', status: '健康', highlight: '和解' }],
    reveals: [], foreshadows: [{ id: 'f1', seed: '信封水渍', payoff: '十年前的痕迹', plantAt: 1, revealAt: 4 }],
    volumes: [{ title: '卷一 雨季', goal: '建立谜题',
      chapters: Array.from({ length: 5 }, (_, i) => ({ title: `雨信${i + 1}`, summary: `第${i + 1}章`,
        writerSummary: '林砚追查来源', writerGoal: '取得线索', goal: '发现变化', cast: ['林砚'],
        foreshadows: i === 0 ? [{ id: 'f1', action: 'plant' }] : [] })) }],
  })
}

function startMock() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'm', object: 'chat.completion', model: 'mock',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: outlineJSON() } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 } }))
    })
  })
  return { srv }
}

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }
function startStatic() {
  const srv = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    const file = url === '/' || url === '/index.html' ? path.join(DIST, 'index.html') : path.resolve(DIST, '.' + url)
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end() }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('404') }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(buf)
    })
  })
  return { srv }
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { await new Promise((ok, no) => { const r = http.get({ host: '127.0.0.1', port, path: '/' }, (x) => { x.resume(); ok() }); r.on('error', no); r.setTimeout(400, () => r.destroy(new Error('t'))) }); return true }
    catch { await sleep(250) }
  }
  return false
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))

/**
 * playwright-core 的解析：优先项目内 node_modules，其次本机全局工作区。
 * 用 index.mjs（只有它导出 chromium；index.js 的顶层是 default 实例对象）。
 */
async function loadChromium() {
  const candidates = [
    path.join(MOBI, 'node_modules/playwright-core/index.mjs'),
    'C:/Users/zbj/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs',
  ]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const m = await import('file://' + p.replace(/\\/g, '/'))
    if (m.chromium) return m.chromium
  }
  throw new Error('未找到 playwright-core（可 npm i -D playwright-core，或复用全局工作区）')
}

const results = []
function check(name, cond, detail = '') { results.push({ name, ok: !!cond, detail }); log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

let mock, vitesrv, app, edge
async function main() {
  fs.rmSync(BACKUP, { recursive: true, force: true })
  fs.mkdirSync(path.join(BACKUP, 'projects'), { recursive: true })
  if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, path.join(BACKUP, 'config.json'))
  for (const f of fs.readdirSync(PROJECTS)) fs.copyFileSync(path.join(PROJECTS, f), path.join(BACKUP, 'projects', f))
  fs.writeFileSync(CONFIG, JSON.stringify({ baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock', apiKey: 'k', thinking: false }))

  mock = startMock(); await new Promise((r) => mock.srv.listen(MOCK_PORT, '127.0.0.1', r))
  app = spawn(process.execPath, [path.join(MOBI, 'server', 'index.js')], { cwd: MOBI, env: { ...process.env, PORT: String(APP_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
  app.stderr.on('data', (d) => process.stderr.write('[app] ' + d))
  if (!await waitPort(APP_PORT)) throw new Error('后端未启动')
  await sleep(500)
  log('服务已就绪（后端同源托管 dist）')

  const PROFILE = path.join(__dirname, 'edge-profile-nav')
  fs.rmSync(PROFILE, { recursive: true, force: true })
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-proxy-server', '--disable-gpu', '--window-size=430,932', 'about:blank'], { stdio: 'ignore' })
  await sleep(2500)

  const chromium = await loadChromium()
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9334')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.setViewportSize({ width: 430, height: 932 })

  // 后端同源托管 dist ⇒ 前端 fetch('/api/...') 直接命中，不需要额外代理
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'load' })
  await page.waitForTimeout(1200)

  fs.mkdirSync(SHOTS, { recursive: true })

  // 直接走 UI：点「写一个新的故事」→ 填灵感 → 交给墨笔（假模型秒回）
  const newBtn = page.locator('button', { hasText: '写一个新的故事' })
  check('书架页有「写一个新的故事」', await newBtn.count() > 0)
  await newBtn.first().click()
  await page.waitForSelector('textarea', { timeout: 10000 })

  /* 灵感是必填项：空的时候「交给墨笔」必须**变灰**（而不是点下去才报错）。
     这一段必须在 fill 之前跑，否则灵感已有内容、按钮本来就该可点。 */
  const createBtn = page.locator('button', { hasText: '交给墨笔' }).first()
  check('灵感为空时「交给墨笔」是禁用的（灰态）', await createBtn.isDisabled())
  await page.screenshot({ path: path.join(SHOTS, 'nav-1a-create-empty-disabled.png') })
  // 纯空白也不算填了 —— 只打几个空格仍应禁用
  await page.locator('textarea').first().fill('   ')
  await page.waitForTimeout(120)
  check('只输入空白字符时仍禁用（trim 后为空）', await createBtn.isDisabled())
  // 真正填了内容才启用
  await page.locator('textarea').first().fill('主角在雨夜收到来自十年后的信')
  await page.waitForTimeout(120)
  check('填写灵感后「交给墨笔」恢复可点', !(await createBtn.isDisabled()))
  // 标题栏要写清这是必填
  check('灵感标题旁标注了「必填」',
    (await page.locator('.section-title', { hasText: '你的灵感' }).innerText()).includes('必填'))
  await page.screenshot({ path: path.join(SHOTS, 'nav-1b-create-filled-enabled.png') })

  await createBtn.click()
  await page.waitForSelector('.outline-head, .topbar__menu', { timeout: 30000 })
  await page.waitForTimeout(800)

  // ① 打开「创作资料与编辑」，检查头部 ☰
  const matBtn = page.locator('.nav-drawer .nav-item', { hasText: '创作资料与编辑' })
  // 先进作品（点 ☰ 打开导航抽屉）
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(500)
  check('导航抽屉里有「剧情方向修改」入口',
    await page.locator('.nav-drawer .nav-item', { hasText: '剧情方向修改' }).count() > 0)
  await page.screenshot({ path: path.join(SHOTS, 'nav-1-drawer.png') })

  await page.locator('.nav-drawer .nav-item', { hasText: '创作资料与编辑' }).click()
  await page.waitForTimeout(600)
  // ⚠️ 它现在是**整页**，不是浮层抽屉：不应再有 .drawer--wide / .drawer-mask / ✕
  check('创作资料是整页（不再是浮窗抽屉）', await page.locator('.drawer--wide').count() === 0)
  check('创作资料页没有浮层遮罩', await page.locator('.drawer-mask').count() === 0)
  check('创作资料页走全局顶栏（☰ 在顶栏里）', await page.locator('.topbar__menu').count() > 0)
  check('顶栏标题是「创作资料与编辑」',
    (await page.locator('.topbar__title').innerText().catch(() => '')).includes('创作资料与编辑'))
  check('创作资料页没有 ✕ 关闭键（页面返回靠 ‹ / 返回键）',
    await page.locator('.drawer__close, .topbar .icon-btn[aria-label="关闭"]').count() === 0)
  check('创作资料页有六个标签', (await page.locator('.editor-tab').count()) === 6)
  await page.screenshot({ path: path.join(SHOTS, 'nav-2-materials-page.png') })

  // ①b 点顶栏 ☰ ⇒ 应打开导航抽屉，而且**创作资料页不会被关掉**（这正是原来的病）
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(600)
  check('☰ 打开了作品导航', await page.locator('.nav-drawer').count() > 0)
  check('☰ 之后创作资料页还在（不再「点目录自动退出这个界面」）',
    (await page.locator('.topbar__title').innerText().catch(() => '')).includes('创作资料与编辑'))
  check('☰ 不是「点了没反应」（导航抽屉真的出现了）', await page.locator('.nav-drawer .nav-item').count() > 0)
  await page.screenshot({ path: path.join(SHOTS, 'nav-2b-nav-over-page.png') })

  // ①c 返回键：导航抽屉开着时，返回只关抽屉、不退页面
  await page.goBack()
  await page.waitForTimeout(600)
  check('返回键先关掉导航抽屉', await page.locator('.nav-drawer').count() === 0)
  check('返回键没有把创作资料页退掉', await page.locator('.topbar__title').innerText()
    .then((t) => t.includes('创作资料与编辑')).catch(() => false))

  // ①d 设置 → 章节目标：数字型草稿不该是一个半屏大空框
  await page.locator('.editor-tab', { hasText: '设置' }).click()
  await page.waitForTimeout(300)
  await page.locator('.edit-label', { hasText: '修改内容' }).locator('select')
    .selectOption('target_chapters')
  await page.waitForTimeout(400)
  const row = page.locator('.field-row')
  const numBox = await page.locator('.field--num').boundingBox()
  const pageBox = await page.locator('.page').boundingBox()
  check('章节目标：输入框已收窄（不再是半屏宽的大框）', !!numBox && numBox.width <= 160,
    numBox ? `宽 ${Math.round(numBox.width)}px / 页面 ${Math.round(pageBox?.width || 0)}px` : '取不到尺寸')
  check('章节目标：输入框不再是超高文本框', !!numBox && numBox.height <= 70,
    numBox ? `高 ${Math.round(numBox.height)}px` : '取不到尺寸')
  check('章节目标：旁边有「章」单位', (await row.locator('.field-row__unit').innerText().catch(() => '')).includes('章'))
  check('章节目标：输入框这一行写着字段名（不会出现孤零零一个 73）',
    (await row.locator('.field-row__label').innerText().catch(() => '')).includes('章节目标'))
  check('章节目标：没有整页高的大 textarea', await page.locator('.page textarea').count() === 0)

  // 长文本字段仍然要有标题，且标题跟着下拉走
  await page.locator('.edit-label', { hasText: '修改内容' }).locator('select').selectOption('styleSpec')
  await page.waitForTimeout(300)
  check('文风设定：长文本框上方有标题「文风设定」',
    (await page.locator('.draft-head__label').innerText().catch(() => '')).includes('文风设定'))
  // 其他短字段不该再重复一个同名标题（下拉已经说明了在改什么）
  await page.locator('.editor-tab', { hasText: '角色卡' }).click()
  await page.waitForTimeout(300)
  check('角色卡：短字段不再重复显示冗余标题（标题由「修改内容」下拉给出）',
    (await page.locator('.draft-head').count()) === 0)
  await page.locator('.editor-tab', { hasText: '设置' }).click()
  await page.waitForTimeout(300)

  // ①e 每个标签都点一遍：确认切换不崩
  for (const label of ['主题', '三幕', '角色卡', '世界观', '伏笔', '设置']) {
    await page.locator('.editor-tab', { hasText: label }).first().click()
    await page.waitForTimeout(180)
  }
  check('六个标签轮流切换后页面仍在（无白屏/崩溃）', await page.locator('.editor-tabs').count() > 0)
  const tabsBox = await page.locator('.editor-tabs').boundingBox()
  const tabBoxes = await page.locator('.editor-tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()))
  const widest = Math.max(...tabBoxes.map((b) => b.right))
  // 标签栏不能有「空行」：grid 的 implicit row 只在该行真有子项时产生。
  // 实测过一次「最后一行只有一个标签却撑出一整行空白」，这里锁住。
  const tabsH = (await page.locator('.editor-tabs').boundingBox())?.height || 0
  const maxRowBottom = Math.max(...tabBoxes.map((b) => b.bottom))
  check('标签栏高度贴合内容（没有多余空行）',
    !!tabsBox && tabsH <= (maxRowBottom - tabsBox.y) + 24,
    `标签栏高 ${Math.round(tabsH)}px / 内容到 ${Math.round(maxRowBottom - (tabsBox?.y || 0))}px`)
  check('标签栏一屏看全（不横滑、不被截断）',
    !!tabsBox && widest <= tabsBox.x + tabsBox.width + 1,
    `最右标签 ${Math.round(widest)}px / 栏右沿 ${Math.round((tabsBox?.x || 0) + (tabsBox?.width || 0))}px`)
  check('贴底操作条存在（与剧情方向修改同构）', await page.locator('.footer-actions').count() > 0)
  await page.screenshot({ path: path.join(SHOTS, 'nav-2c-materials-settings.png') })

  // ①f 返回键退一层：创作资料 → 大纲（页面栈语义，不再靠关浮层）
  await page.goBack()
  await page.waitForTimeout(700)
  check('返回键从创作资料页退回大纲页', await page.locator('.outline-head').count() > 0)

  // ①g AI 助手也是整页
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(500)
  check('导航项已改名为「AI 助手」（不再是「创作讨论」）',
    await page.locator('.nav-drawer .nav-item', { hasText: 'AI 助手' }).count() > 0)
  await page.locator('.nav-drawer .nav-item', { hasText: 'AI 助手' }).click()
  await page.waitForTimeout(700)
  check('AI 助手是整页（不再是浮窗抽屉）', await page.locator('.drawer--wide').count() === 0)
  check('AI 助手页没有浮层遮罩', await page.locator('.drawer-mask').count() === 0)
  const aTitle = await page.locator('.topbar__title').innerText().catch(() => '')
  const aMenuBox = await page.locator('.topbar__menu').boundingBox()
  const aTitleBox = await page.locator('.topbar__title').boundingBox()
  check('AI 助手顶栏标题正确', aTitle.includes('AI 助手'), `标题 = ${JSON.stringify(aTitle)}`)
  check('顶栏最左是 ☰ 目录键（与其它页面一致）',
    !!aMenuBox && !!aTitleBox && aMenuBox.x < aTitleBox.x,
    aMenuBox && aTitleBox ? `☰ x=${Math.round(aMenuBox.x)} < 标题 x=${Math.round(aTitleBox.x)}` : '取不到坐标')
  check('「AI 助手」紧贴 ☰（间距 < 80px）',
    !!aMenuBox && !!aTitleBox && (aTitleBox.x - (aMenuBox.x + aMenuBox.width)) < 80,
    aMenuBox && aTitleBox ? `间距 ${Math.round(aTitleBox.x - (aMenuBox.x + aMenuBox.width))}px` : '取不到坐标')
  check('AI 助手页没有 ✕ 关闭键', await page.locator('.drawer__close').count() === 0)
  check('AI 助手有撑满的输入框', (await page.locator('.page textarea').count()) === 1)
  check('AI 助手有贴底操作条', await page.locator('.footer-actions').count() > 0)
  const genBox = await page.locator('.footer-actions .btn').boundingBox()
  const pageBox2 = await page.locator('.page').boundingBox()
  // 页面左右各 18px padding；.btn--grow 撑满的是这段可用宽度（已含 .btn 自身内边距）。
  // ⚠️ 基准必须用**兄弟节点为空的操作条内部可用宽**，不能用 .page 宽度 —
  //    页面有纵向滚动条时会吃掉十几 px，拿 pageBox 当基准会假失败（踩过）。
  //    最稳的判据：按钮是操作条的独子时，其 offsetWidth 应等于「操作条内容区宽」。
  const fill = await page.locator('.footer-actions').evaluate((el) => {
    const kids = [...el.children]
    const btn = kids[0]
    const cs = getComputedStyle(el)
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const gaps = parseFloat(cs.gap || 0) * Math.max(0, kids.length - 1)
    return { kids: kids.length, inner, gaps, btnW: btn.offsetWidth,
      need: inner - gaps, flex: getComputedStyle(btn).flex }
  })
  check('「生成建议」按钮撑满操作条（不再半宽孤零零）',
    fill.kids === 1 && Math.abs(fill.btnW - fill.need) <= 2,
    `按钮 ${fill.btnW}px / 应占 ${Math.round(fill.need)}px（内容区 ${Math.round(fill.inner)}px，兄弟 ${fill.kids} 个，flex=${fill.flex}）`)
  await page.screenshot({ path: path.join(SHOTS, 'nav-2d-assistant-page.png') })

  // ①h AI 助手页点 ☰ ⇒ 打开导航，且 AI 助手页不会被关掉
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(600)
  check('AI 助手页点 ☰ 打开了导航', await page.locator('.nav-drawer').count() > 0)
  await page.goBack()
  await page.waitForTimeout(600)
  check('AI 助手页返回键只关导航、不退页',
    (await page.locator('.topbar__title').innerText().catch(() => '')).includes('AI 助手'))
  await page.goBack()
  await page.waitForTimeout(700)
  check('AI 助手页再返回 ⇒ 退回大纲页', await page.locator('.outline-head').count() > 0)

  // ② 从大纲页重新走一遍：☰ → 剧情方向修改（这一段的起点已收干净）
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(600)
  check('重新打开作品导航成功', await page.locator('.nav-drawer').count() > 0)

  // ③ 点「剧情方向修改」⇒ 进独立页
  await page.locator('.nav-drawer .nav-item', { hasText: '剧情方向修改' }).click()
  await page.waitForTimeout(700)
  check('进入了「剧情方向修改」独立页', (await page.locator('.section-title', { hasText: '剧情方向' }).count()) > 0)
  const ta = page.locator('textarea').first()
  check('页面有可编辑的剧情方向输入框', await ta.count() > 0)
  await ta.fill('接下来三章压住感情线，先查父亲的旧案；不要过早引入超自然元素。')
  await page.screenshot({ path: path.join(SHOTS, 'nav-3-direction.png') })

  // ④ 预览影响（走真实后端）
  const pv = page.locator('button', { hasText: '预览影响' })
  check('有「预览影响」按钮', await pv.count() > 0)
  check('预览按钮未被禁用', !(await pv.first().isDisabled()))
  const bodyTxt = await page.locator('.page').innerText().catch(() => '')
  if (!/(?:await pv|预览影响)/.test('')) log('    页面文本片段:', JSON.stringify(bodyTxt.slice(0, 300)))
  await pv.first().click()
  await page.waitForTimeout(2000)
  const hasPreview = await page.locator('.change-preview').count() > 0
  if (!hasPreview) {
    const errTxt = await page.locator('.notice--err').innerText().catch(() => '(无错误提示)')
    const after = await page.locator('.page').innerText().catch(() => '')
    log('    失败诊断: 错误提示 =', JSON.stringify(errTxt))
    log('    失败诊断: 页面文本 =', JSON.stringify(after.slice(0, 400)))
  }
  check('预览影响返回了可确认的修改请求', hasPreview)
  await page.screenshot({ path: path.join(SHOTS, 'nav-4-direction-preview.png') })

  if (hasPreview) {
    await page.locator('button', { hasText: '确认并提交' }).first().click()
    await page.waitForTimeout(2000)
    const okc = await page.locator('.notice').count() > 0
    check('确认提交后有结果提示', okc)
    await page.screenshot({ path: path.join(SHOTS, 'nav-5-direction-submitted.png') })
  }

  await browser.close()
}

try { await main() } catch (e) { log('\n[异常]', e.message); results.push({ name: '执行异常', ok: false, detail: e.message }) }
finally {
  try { edge?.kill() } catch {}
  try { app?.kill() } catch {}
  try { mock?.srv?.close() } catch {}
  try { vitesrv?.srv?.close() } catch {}
  await sleep(400)
  if (fs.existsSync(path.join(BACKUP, 'config.json'))) fs.copyFileSync(path.join(BACKUP, 'config.json'), CONFIG)
  fs.rmSync(PROJECTS, { recursive: true, force: true }); fs.mkdirSync(PROJECTS, { recursive: true })
  for (const f of fs.readdirSync(path.join(BACKUP, 'projects'))) fs.copyFileSync(path.join(BACKUP, 'projects', f), path.join(PROJECTS, f))
  fs.rmSync(BACKUP, { recursive: true, force: true })
  log(`\n已恢复原始数据（作品 ${fs.readdirSync(PROJECTS).length} 个）`)
  const pass = results.filter((r) => r.ok).length
  log(`\n===== 结果 ${pass}/${results.length} =====`)
  for (const r of results) if (!r.ok) log(`  FAIL: ${r.name} ${r.detail}`)
  process.exit(0)
}
