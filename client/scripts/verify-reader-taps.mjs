#!/usr/bin/env node
/**
 * 阅读页交互验收（真 Edge + CDP）。
 *
 * 覆盖用户报的四个现象：
 *   ① 点中间：状态栏该淡出/淡入（原先**根本没实现**，body 上没有任何点击处理）
 *   ② 点左右两边：该翻页（原先 `flip()` 只绑给音量键，且只做横向滚动 —— 默认是上下滚动模式，点了没反应）
 *   ③ 左右翻页模式：整页不该能被上下拖动（根因在**文档级**滚动没锁，不是正文容器）
 *   ④ 方向键：状态栏可见时不抢键，**隐藏后必须真的能翻页**
 *
 * 零成本零副作用：用 `MOBI_DATA_DIR` 指到临时目录 + 种一本假作品 ⇒ 不碰真实 data/、不调模型。
 * 用法：npm run verify:reader      （需先 npm run build）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBI = path.resolve(__dirname, '..')
const DIST = path.join(MOBI, 'dist')
const PORT = 8795
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

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
  throw new Error('未找到 playwright-core')
}

/** 种一本有**长正文**的书：第 1 章够长（能翻好几屏/好几列），第 2 章用来验边界切章。 */
function seedProject(dir) {
  const long = Array.from({ length: 260 }, (_, i) =>
    `第${i + 1}段，走廊尽头的窗子开着，风把练习册的纸角掀起来又放下。他把那句话在心里过了一遍，没有说出口。`).join('\n\n')
  const project = {
    id: 'p_reader', schemaVersion: 2, headVersion: 2, editRevision: 0, targetChapters: 2,
    title: '阅读页验收书', idea: '用来验收阅读页交互', genre: '悬疑',
    preferences: {},
    chapters: [
      { no: 1, title: '长章', status: 'committed', text: long, summary: '长章' },
      { no: 2, title: '短章', status: 'committed', text: '第二章很短。他只说了一句话。', summary: '短章' },
    ],
    entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [] }],
    outline: {
      totalChapters: 2, plannedDetailThrough: 2,
      volumes: [{ title: '卷一', chapters: [
        { no: 1, title: '长章', summary: '长章', cast: ['ent_a'] },
        { no: 2, title: '短章', summary: '短章', cast: ['ent_a'] },
      ] }],
    },
    ledger: { canonicalFacts: [], currentState: [], characterKnowledge: [], plotThreads: [], stateEvents: [], foreshadowEvents: [] },
  }
  fs.writeFileSync(path.join(dir, 'projects', 'p_reader.json'), JSON.stringify(project))
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { await new Promise((ok, no) => { const r = http.get({ host: '127.0.0.1', port, path: '/' }, (x) => { x.resume(); ok() }); r.on('error', no); r.setTimeout(400, () => r.destroy(new Error('t'))) }); return true }
    catch { await sleep(250) }
  }
  return false
}

let app, edge, PROFILE
async function main() {
  if (!EDGE) throw new Error('未找到 msedge')
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('缺少 dist/，请先 npm run build')

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-reader-ui-'))
  fs.mkdirSync(path.join(DATA, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(DATA, 'runs'), { recursive: true })
  fs.mkdirSync(path.join(DATA, 'changes'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ baseURL: 'http://127.0.0.1:9/v1', model: 'mock', apiKey: 'k', thinking: false }))
  seedProject(DATA)
  log(`已隔离数据目录：${DATA}`)

  app = spawn(process.execPath, [path.join(MOBI, 'server', 'index.js')],
    { cwd: MOBI, env: { ...process.env, PORT: String(PORT), MOBI_DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] })
  app.stderr.on('data', (d) => process.stderr.write('[app] ' + d))
  if (!await waitPort(PORT)) throw new Error('后端未启动')

  PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-reader-edge-'))
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9338', `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-proxy-server', '--disable-gpu', '--window-size=430,932', 'about:blank'], { stdio: 'ignore' })
  await sleep(2500)

  const chromium = await loadChromium()
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9338')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.setViewportSize({ width: 430, height: 932 })

  /** 进阅读页：书架 → 作品 → 第一个已定稿章节 */
  const enterReader = async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
    await page.waitForTimeout(900)
    await page.locator('.book-card').first().click()
    await page.waitForTimeout(800)
    await page.locator('.chapter-row--link').first().click()
    await page.waitForTimeout(900)
  }
  await enterReader()
  check('进入了阅读页', (await page.locator('.reader-page').count()) === 1)

  const body = page.locator('.reader-page__body')
  const box = await body.boundingBox()
  const at = (fx, fy = 0.5) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const bareCount = () => page.locator('.reader-page--bare').count()
  const topStyle = () => page.locator('.reader-page__top').evaluate((el) => {
    const cs = getComputedStyle(el)
    return { display: cs.display, opacity: cs.opacity }
  })
  const bodyH = () => body.evaluate((el) => el.clientHeight)
  const scrollPos = () => body.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }))
  /**
   * 等平滑滚动停下来再断言。
   * ⚠️ 我第一次用固定 sleep，量到的是动画中间值，把「上一次点击还在滑」误判成了
   *    「拖动导致翻页」——**断言失败先怀疑断言**。
   */
  const settle = async () => {
    let last = await scrollPos()
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(120)
      const now = await scrollPos()
      if (now.top === last.top && now.left === last.left) return now
      last = now
    }
    return last
  }
  const tap = async (fx) => { const p = at(fx); await page.mouse.click(p.x, p.y); await page.waitForTimeout(250); await settle() }

  /* ---------- ①② 点击分区：中间开关状态栏、左右翻页 ---------- */

  const hShown = await bodyH()
  check('初始状态：状态栏可见', (await bareCount()) === 0 && (await topStyle()).display !== 'none')
  await tap(0.5)
  const hBare = await bodyH()
  check('点正文中间 → 状态栏真的收起来（display:none）',
    (await bareCount()) === 1 && (await topStyle()).display === 'none', JSON.stringify(await topStyle()))
  // ⛔ 主人第一版验收就指出：只淡出会「上下还留着占位、文字渲染不到那里」 ⇒ 判据必须看**正文是否变高**
  check('⛔ 收起来之后空间**还给正文**（不是只淡出留占位）', hBare > hShown + 40, `正文高 ${hShown} → ${hBare}`)
  await tap(0.5)
  check('再点中间 → 状态栏回来且正文高度复原',
    (await bareCount()) === 0 && (await bodyH()) === hShown, `${await bodyH()} vs ${hShown}`)

  const p0 = await scrollPos()
  await tap(0.9)
  const p1 = await scrollPos()
  check('点右边 → 往下翻一屏（原先默认滚动模式下完全没反应）', p1.top > p0.top + 100, `${p0.top} → ${p1.top}`)
  await tap(0.1)
  const p2 = await scrollPos()
  check('点左边 → 往上翻一屏', p2.top < p1.top - 100, `${p1.top} → ${p2.top}`)

  // 拖拽/滑动不该被当成点击（否则一滑就误翻页）
  const beforeDrag = await settle()
  const c = at(0.9)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x - 60, c.y + 20, { steps: 6 })
  await page.mouse.up()
  const afterDrag = await settle()
  check('拖动/滑动不算点击（不会误翻页）', afterDrag.top === beforeDrag.top, `${beforeDrag.top} → ${afterDrag.top}`)

  /* ---------- ④ 方向键：状态栏可见时不抢键，隐藏后必须真的能翻 ---------- */

  const beforeKey = await settle()
  await page.keyboard.press('ArrowRight')
  await settle()
  check('状态栏可见时方向键不翻页（用户确认这个设计是对的）', (await scrollPos()).top === beforeKey.top)

  await tap(0.5) // 隐藏状态栏
  check('已进入沉浸（状态栏隐藏）', (await bareCount()) === 1)
  const beforeKey2 = await settle()
  await page.keyboard.press('ArrowRight')
  await settle()
  check('状态栏隐藏后 ArrowRight 真的能翻页（用户最关心的一条）',
    (await scrollPos()).top > beforeKey2.top + 100, `${beforeKey2.top} → ${(await scrollPos()).top}`)
  const beforeKey3 = await settle()
  await page.keyboard.press('ArrowLeft')
  await settle()
  check('ArrowLeft 反向翻页', (await scrollPos()).top < beforeKey3.top - 100)

  /* ---------- 边界切章（滚动模式） ---------- */
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(300)
  await tap(0.9)
  const chapterLabel = await page.locator('.reader-page__top-sub').innerText().catch(() => '')
  check('滚到底再点右边 → 切到下一章', /第\s*2\s*章/.test(chapterLabel), JSON.stringify(chapterLabel))

  /* ---------- ③ 左右翻页模式：列要真的形成、纵向要真的锁死 ---------- */
  await page.evaluate(() => localStorage.setItem('mobi_reader_prefs', JSON.stringify({ pageMode: 'page' })))
  await enterReader()
  check('已切换到左右翻页模式', (await page.locator('.reader-page__body--page').count()) === 1)

  const geom = await page.evaluate(() => {
    const el = document.querySelector('.reader-page__body')
    const cs = getComputedStyle(el)
    return {
      sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
      overflowY: cs.overflowY, columnWidth: cs.columnWidth,
      docOverflow: getComputedStyle(document.documentElement).overflowY,
      docScrollable: document.documentElement.scrollHeight - window.innerHeight,
      innerH: window.innerHeight,
    }
  })
  check('正文真的分成了多列（scrollWidth > 一屏宽）', geom.sw > geom.cw + 50,
    `scrollWidth=${geom.sw} clientWidth=${geom.cw} columnWidth=${geom.columnWidth}`)
  check('正文容器纵向锁死', geom.overflowY === 'hidden', `overflow-y=${geom.overflowY}`)
  check('⛔ 整个文档不再可上下拖动（用户报的第三个现象）',
    geom.docOverflow === 'hidden' && geom.docScrollable <= 2,
    `html overflow-y=${geom.docOverflow} 可滚高度=${geom.docScrollable}px / 视口 ${geom.innerH}px`)

  // ⚠️ `overflow:hidden` 仍然允许**程序化**给 scrollTop 赋值（规范行为，按那个断言会假失败）。
  //    要验的是**用户滚不动**：滚轮/手势之后位置必须还是 0。
  await body.evaluate((el) => { el.scrollTop = 0 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(300)
  const afterWheel = await page.evaluate(() => ({
    bodyTop: document.querySelector('.reader-page__body').scrollTop,
    docTop: document.documentElement.scrollTop || document.body.scrollTop || 0,
  }))
  check('滚轮/手势都拖不动页面（正文与整个文档都停在原位）',
    afterWheel.bodyTop === 0 && afterWheel.docTop === 0, JSON.stringify(afterWheel))

  const h0 = await scrollPos()
  await tap(0.9)
  const h1 = await scrollPos()
  check('左右翻页模式：点右边 → 横向翻一列', h1.left > h0.left + 100, `left ${h0.left} → ${h1.left}`)
  await tap(0.1)
  const h2 = await scrollPos()
  check('左右翻页模式：点左边 → 横向翻回上一列', h2.left < h1.left - 100, `left ${h1.left} → ${h2.left}`)

  /* ---------- ⑤ 左右翻页要「翻页」，不能停在两列中间 ---------- */
  // 用滚轮制造「滚动到一半」的状态。手指横向拖动与滚轮**都会触发 scroll 事件**，
  // 而吸附逻辑挂在 scroll 上，所以这条断言对手势与滚轮同等有效。
  const colWpx = await body.evaluate((el) => parseFloat(getComputedStyle(el).columnWidth) || 0)
  const wheelHalf = async (dx) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(dx, 0)
    await page.waitForTimeout(60)                  // 吸附在停止 140ms 后才触发，先读「原始」位置
    const raw = (await scrollPos()).left
    await page.waitForTimeout(500)
    return { raw, snapped: (await settle()).left }
  }
  const boundaryOf = (x) => Math.abs(x - Math.round(x / colWpx) * colWpx) <= 2
  const a = await wheelHalf(150)
  check('左右翻页：滚动到一半后**吸附到整列**（不会停在两列中间，那是滚动不是翻页）',
    boundaryOf(a.snapped) && Math.abs(a.snapped - a.raw) <= colWpx / 2 + 4,
    `原始 ${a.raw} → 吸附后 ${a.snapped}（列宽 ${colWpx}）`)
  const b = await wheelHalf(320)
  check('左右翻页：再滚过半页 → 落到下一列的边界上', boundaryOf(b.snapped),
    `原始 ${b.raw} → 吸附后 ${b.snapped}`)

  /* ---------- ⑥ 阅读设置：滑条不再吃掉纵向手势，并给了一对 ± ---------- */
  await page.locator('.tool-item', { hasText: '设置' }).click()
  await page.waitForTimeout(500)
  const ta = await page.locator('.rset .chapter-range').first().evaluate((el) => getComputedStyle(el).touchAction)
  check('设置面板滑条：纵向手势不再被它吃掉（touch-action: pan-y）', ta === 'pan-y', `touch-action=${ta}`)
  check('三根滑条各配一对 ± 步进按钮', (await page.locator('.rset__step').count()) === 6)
  const v0 = (await page.locator('.rset__v').first().innerText()).trim()
  await page.locator('.rset__step').nth(1).click()   // 第一个字段（字号）的「+」
  await page.waitForTimeout(250)
  const v1 = (await page.locator('.rset__v').first().innerText()).trim()
  check('点「+」真的把字号调大了（不必靠拖滑条）', v1 !== v0, `${v0} → ${v1}`)

  /* ---------- ⑧ 进度条：可拖动（在本章内跳转） ---------- */
  // ⚠️ 这段落在脚本末尾，此时已是**左右翻页模式**（纵向锁死 ⇒ 横向才是轴）。
  //    所以按当前模式选轴来判，而不是想当然用 scrollTop（我第一版就栽在这，max=0）。
  await tap(0.5)   // 先确保状态栏可见（沉浸时它是 display:none，进度条点不到）
  const isPageNow = (await page.locator('.reader-page__body--page').count()) === 1
  const axis = isPageNow ? 'left' : 'top'
  const slider = page.locator('.reader-page__slider')
  const sbox = await slider.boundingBox()
  const clickAt = async (fx) => {
    await page.mouse.click(sbox.x + sbox.width * fx, sbox.y + sbox.height / 2)
    await page.waitForTimeout(250)
    return settle()
  }
  const sMax = await body.evaluate((el, ax) => (ax === 'left'
    ? el.scrollWidth - el.clientWidth
    : el.scrollHeight - el.clientHeight), axis)
  const atFar = await clickAt(0.85)
  check(`点/拖进度条 85% ⇒ 本章跳到后面（纵向轴=${axis}；原来是 readOnly，拖不动）`,
    atFar[axis] > sMax * 0.6, `${axis}=${atFar[axis]} / max=${sMax}`)
  const atNear = await clickAt(0.08)
  check('点/拖进度条 8% ⇒ 本章回到前面', atNear[axis] < sMax * 0.3, `${axis}=${atNear[axis]} / max=${sMax}`)
  check('滑块数值与正文位置一致（指示器与跳转用的是同一个值）',
    Math.abs(Number(await slider.inputValue()) - Math.round((atNear[axis] / sMax) * 100)) <= 3,
    `滑块=${await slider.inputValue()} 位置=${Math.round((atNear[axis] / sMax) * 100)}%`)

  /* ---------- ⑦ 界面上不该出现未渲染的 markdown ---------- */
  const bodyText = await page.locator('body').innerText()
  check('界面上不出现未渲染的 markdown 粗体（**…**）', !bodyText.includes('**'),
    bodyText.includes('**') ? bodyText.slice(Math.max(0, bodyText.indexOf('**') - 20), bodyText.indexOf('**') + 20) : '')

  await browser.close()
  fs.rmSync(DATA, { recursive: true, force: true })
}

try { await main() } catch (e) { log('\n[异常]', e.message); results.push({ name: '执行异常', ok: false, detail: e.message }) }
finally {
  try { edge?.kill() } catch {}
  try { app?.kill() } catch {}
  await sleep(300)
  try { if (PROFILE) fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
  const pass = results.filter((r) => r.ok).length
  log(`\n===== 结果 ${pass}/${results.length} =====`)
  for (const r of results) if (!r.ok) log(`  FAIL: ${r.name} ${r.detail}`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}
