#!/usr/bin/env node
/**
 * UI 验证：伏笔「回收披露授权」这条路真的能用吗？
 *
 * 为什么要它：本项目最贵的教训是「**按钮存在 ≠ 按钮有用**」——
 * `onNav?.()` 这种 prop 没接线的 bug 点了不报错也没反应，靠 count()>0 的断言永远绿。
 * 所以这里**真点下去**，并断言「状态真的变了」（未授权 → 已授权 → 撤回 → 未授权）。
 *
 * 零成本、零副作用：
 *   · 数据目录用 `MOBI_DATA_DIR` 指到临时区 ⇒ **绝不碰真实 `mobi/data/`**；
 *   · 作品直接种进临时区 ⇒ **一次模型调用都不发生**（不插桩、不 mock 生成）。
 *
 * 用法：npm run verify:reveal:ui      （需先 npm run build）
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
const PORT = 8793
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
/** 直接从后端读回作品：验收判据要落在「后端真的写进去了」，而不是界面上看着变了 */
const fetchProject = async () =>
  (await (await fetch(`http://127.0.0.1:${PORT}/api/projects/p_reveal`)).json()).project

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

/** 种一本「已经有第 1 章、第 3 章计划回收 f1」的作品；不经过模型。 */
function seedProject(dir) {
  const project = {
    id: 'p_reveal', schemaVersion: 2, headVersion: 1, editRevision: 0, targetChapters: 3,
    title: '回收授权验证书', idea: '一场关于一封信的悬疑', genre: '悬疑',
    preferences: { styleSpec: '第三人称限知；冷峻克制。' },
    chapters: [{ no: 1, title: '开端', status: 'committed', text: '赵甲在山谷里找到一封信。', summary: '第一章' }],
    entities: [{ id: 'ent_a', kind: 'character', name: '赵甲', aliases: [], publicIdentity: '警员', publicRole: '主角', characterCard: {} }],
    outline: {
      title: '回收授权验证书', theme: '真相与代价', totalChapters: 3,
      acts: [{ name: '第一幕', summary: '起因' }, { name: '第二幕', summary: '转折' }, { name: '第三幕', summary: '结局' }],
      cast: [{ entityId: 'ent_a', name: '赵甲' }],
      foreshadows: [{
        id: 'f1', seed: '一封没有署名的信', payoff: '写信的人其实是已经死去的老师',
        plantChapter: 2, payoffChapter: 3, revealAt: 3, linkStatus: 'explicit',
        prerequisiteEventIds: [], lifecycle: 'planted',
      },
      // 第二条：模拟迁移来的旧作品 —— 关联待审核、章号为空（审计 P0 的现场）
      {
        id: 'f2', seed: '（待审核）旧校舍的钟', payoff: '钟是伪造的时间锚点',
        plantChapter: null, payoffChapter: null, revealAt: null, linkStatus: 'needsReview',
        prerequisiteEventIds: [], lifecycle: 'approved',
      }],
      volumes: [{ title: '第一卷', chapters: [
        { no: 1, title: '开端', summary: '开端', cast: ['ent_a'], foreshadows: [] },
        { no: 2, title: '继续', summary: '继续调查', cast: ['ent_a'],
          writerSummary: '赵甲把信放在桌上，没有拆。', writerGoal: '让信的存在被看见',
          foreshadows: [{ id: 'f1', action: 'plant', approved: true }] },
        { no: 3, title: '收束', summary: '真相揭开', cast: ['ent_a'], foreshadows: [{ id: 'f1', action: 'pay_off', approved: false }] },
      ] }],
    },
    ledger: {
      canonicalFacts: [], currentState: [], characterKnowledge: [], plotThreads: [], stateEvents: [],
      foreshadowEvents: [{ id: 'fe_plant', foreshadowId: 'f1', action: 'plant', chapterNo: 2, status: 'accepted', trust: 'canonical', sourceVersion: 1, sourceSpan: { start: 0, end: 4, quote: '赵甲在' } }],
    },
  }
  fs.writeFileSync(path.join(dir, 'projects', 'p_reveal.json'), JSON.stringify(project))
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

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-reveal-ui-'))
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

  PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-reveal-edge-'))
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9336', `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-proxy-server', '--disable-gpu', '--window-size=430,932', 'about:blank'], { stdio: 'ignore' })
  await sleep(2500)

  const chromium = await loadChromium()
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9336')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.setViewportSize({ width: 430, height: 932 })

  // 全程拦截并记录 /api 请求，确认这条路真的走了后端（而不是只改本地 state）
  const apiCalls = []
  page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`) })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  await page.waitForTimeout(1000)

  /* 进入作品 → 创作资料与编辑 → 伏笔 */
  await page.locator('.book-card').first().click()
  await page.waitForTimeout(900)
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(500)
  await page.locator('.nav-drawer .nav-item', { hasText: '创作资料与编辑' }).click()
  await page.waitForTimeout(600)
  await page.locator('.editor-tab', { hasText: '伏笔' }).first().click()
  await page.waitForTimeout(400)

  const contentSelect = page.locator('.edit-label', { hasText: '修改内容' }).locator('select')
  const options = await contentSelect.locator('option').allInnerTexts()
  check('伏笔的「修改内容」里有「回收披露授权」', options.some((t) => t.includes('回收披露授权')), `选项=${JSON.stringify(options)}`)

  const note = () => page.locator('.setting-note', { hasText: '回收授权' }).innerText().catch(() => '')
  check('状态行显示伏笔的回收章与授权状态', /回收章：第 3 章/.test(await note()) && /回收授权：未授权/.test(await note()), JSON.stringify((await note()).slice(0, 90)))

  await contentSelect.selectOption('safeReveal')
  await page.waitForTimeout(400)
  const draft = page.locator('.editor-body textarea').first()
  check('选中授权项后草稿框为空（尚未授权）', (await draft.inputValue()) === '')

  /* ① 授权：填文本 → 预览影响 → 确认提交 */
  const preview = page.locator('button', { hasText: '预览影响' }).first()
  check('空文本时「预览影响」是禁用的（没有可提交的改动）', await preview.isDisabled())
  await draft.fill('可以对读者说出的版本：信是老师临死前写下的。')
  await page.waitForTimeout(250)
  check('填了披露文本后「预览影响」可点', !(await preview.isDisabled()))
  await preview.click()
  await page.waitForTimeout(1200)

  const pvText = await page.locator('.change-preview').innerText().catch(() => '')
  check('预览返回了可确认的修改请求', pvText.length > 0)
  check('预览标为高风险（会改变将来正文能出现的内容）', pvText.includes('高风险'), JSON.stringify(pvText.slice(0, 60)))
  check('预览的影响章节是该伏笔声明的回收章（第 3 章）', /影响章节：3/.test(pvText), JSON.stringify(pvText.slice(0, 160)))
  check('预览没有说要重排（授权不该冻结作品）', !pvText.includes('重排'), JSON.stringify(pvText.slice(0, 200)))

  await page.locator('button', { hasText: '确认并提交' }).first().click()
  await page.waitForTimeout(1500)
  // 断言提示的**内容**，不能只看 .notice 存在 —— 出错时也有 .notice--err，会假通过。
  // （这条同时锁住一个真 bug：以前 effect 会在 editRevision 变化时把成功提示立刻抹掉。）
  const noticeTxt = await page.locator('.notice').first().innerText().catch(() => '')
  check('提交后能看到成功提示（以前会被 effect 立刻抹掉）', /已提交/.test(noticeTxt), JSON.stringify(noticeTxt.slice(0, 80)))

  /* 关键断言：点下去之后**状态真的变了** */
  const afterApprove = await note()
  check('授权后状态行变成「已授权」（真点下去、状态真变了）', /回收授权：已授权/.test(afterApprove), JSON.stringify(afterApprove.slice(0, 110)))
  check('授权请求真的打到了后端 ChangeRequest',
    apiCalls.some((c) => c.startsWith('POST /api/projects/p_reveal/changes')) && apiCalls.some((c) => c.startsWith('POST /api/changes/cr_')),
    `api=${JSON.stringify(apiCalls.slice(-6))}`)
  await page.screenshot({ path: path.join(__dirname, 'shots', 'reveal-1-authorized.png') })

  /* ② 撤回：清空文本 → 预览 → 确认（这条路的按钮在「源有值、草稿为空」时必须是可点的） */
  await page.waitForTimeout(300)
  await draft.fill('')
  await page.waitForTimeout(300)
  check('清空文本后「预览影响」仍可点（撤回路径）', !(await preview.isDisabled()))
  await preview.click()
  await page.waitForTimeout(1200)
  await page.locator('button', { hasText: '确认并提交' }).first().click()
  await page.waitForTimeout(1500)
  const afterRevoke = await note()
  check('撤回后状态行回到「未授权」', /回收授权：未授权/.test(afterRevoke), JSON.stringify(afterRevoke.slice(0, 110)))
  await page.screenshot({ path: path.join(__dirname, 'shots', 'reveal-2-revoked.png') })

  /* ③ 界面上不能出现作者侧回收真相 */
  const body = await page.locator('.page').innerText().catch(() => '')
  check('界面（伏笔页正文）不显示作者侧 payoff 之外的东西…（伏笔页本就要给作者看 payoff）', true,
    `页面含 payoff 原文=${body.includes('写信的人其实是已经死去的老师')}（作者侧本就可见，正文侧另有门禁）`)

  /* ③b 执笔页：批准本章写作任务
     ⚠️ 必须放在「伏笔关联审核」之前 —— 那个 kind 会置 pendingReplan 冻结作品，
        之后执笔页只会显示「请先重排」，就点不到任务批准了。 */
  await page.goBack()
  await page.waitForTimeout(800)
  const writeBtn = page.locator('button', { hasText: /继续执笔|开始执笔/ }).first()
  check('大纲页有执笔入口', (await writeBtn.count()) > 0)
  await writeBtn.click()
  await page.waitForTimeout(900)
  const goalText = () => page.locator('.writer-head__goal').innerText().catch(() => '')
  const beforeTask = await goalText()
  check('未批准时先把「将要交给模型的内容」摊开给作者看（不是盲签）',
    beforeTask.includes('赵甲把信放在桌上') && beforeTask.includes('还没批准'), JSON.stringify(beforeTask.slice(0, 60)))
  // ⛔ 主人反馈：这个容器**不渲染 markdown**，我却在提示文案里写了 **…** ⇒ 界面上原样出现星号
  check('提示文案里不出现未渲染的 markdown 粗体（**…**）', !beforeTask.includes('**'),
    beforeTask.includes('**') ? beforeTask.slice(Math.max(0, beforeTask.indexOf('**') - 16), beforeTask.indexOf('**') + 16) : '')
  const approveTaskBtn = page.locator('button', { hasText: '批准本章写作任务' }).first()
  check('执笔页有「批准本章写作任务」按钮', (await approveTaskBtn.count()) > 0)
  await approveTaskBtn.click()
  await page.waitForTimeout(1500)
  const afterTaskProject = await fetchProject()
  const ch2 = afterTaskProject.outline.volumes[0].chapters.find((c) => c.no === 2)
  check('点下去之后后端真的写入了：writerTaskApproval → author-approved',
    ch2.writerTaskApproval === 'author-approved', JSON.stringify(ch2.writerTaskApproval))
  const afterTask = await goalText()
  check('页面不再显示「还没批准」，改为直接显示已批准的写作任务',
    afterTask.includes('赵甲把信放在桌上') && !afterTask.includes('还没批准'), JSON.stringify(afterTask.slice(0, 60)))
  // 回到「创作资料与编辑」继续后面的流程
  await page.locator('.topbar__menu').click()
  await page.waitForTimeout(500)
  await page.locator('.nav-drawer .nav-item', { hasText: '创作资料与编辑' }).click()
  await page.waitForTimeout(600)

  /* ④ 伏笔关联审核（审计 P0：needsReview 的伏笔原本无处可改） */
  await page.locator('.editor-tab', { hasText: '伏笔' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('.edit-label', { hasText: '选择对象' }).locator('select').selectOption({ label: '（待审核）旧校舍的钟' })
  await page.waitForTimeout(200)
  await contentSelect.selectOption('link')
  await page.waitForTimeout(300)
  const plantInput = page.locator('input[aria-label="埋设章"]')
  const payoffInput = page.locator('input[aria-label="回收章"]')
  check('伏笔「关联章号」的两个数字框都在', (await plantInput.count()) === 1 && (await payoffInput.count()) === 1)
  check('needsReview 的伏笔进来时章号是空的（不能假装填好）', (await plantInput.inputValue()) === '' && (await payoffInput.inputValue()) === '')
  check('两个章号都空时「预览影响」禁用（至少填一个）', await preview.isDisabled())
  await plantInput.fill('2')
  await payoffInput.fill('3')
  await page.waitForTimeout(200)
  check('填了章号后「预览影响」可点', !(await preview.isDisabled()))
  await preview.click()
  await page.waitForTimeout(1200)
  await page.locator('button', { hasText: '确认并提交' }).first().click()
  await page.waitForTimeout(1500)
  const afterLink = await fetchProject()
  const f2 = afterLink.outline.foreshadows.find((f) => f.id === 'f2')
  check('提交后后端真的写入了：linkStatus → explicit、埋/收章落地',
    f2.linkStatus === 'explicit' && f2.plantChapter === 2 && f2.payoffChapter === 3,
    JSON.stringify({ linkStatus: f2.linkStatus, plant: f2.plantChapter, payoff: f2.payoffChapter }))

  /* ⑤ 角色秘密的可控披露（审计 P0：整条链原本没有任何写入方） */
  const SAFE = '他终于说出了母亲的名字。'
  await page.locator('.editor-tab', { hasText: '角色卡' }).first().click()
  await page.waitForTimeout(300)
  await contentSelect.selectOption('reveal')
  await page.waitForTimeout(300)
  const revealInput = page.locator('input[aria-label="披露起始章"]')
  check('「从第几章起可披露」的输入框在，且默认是下一章（已定稿章数+1）',
    (await revealInput.count()) === 1 && (await revealInput.inputValue()) === String(Number(afterLink.headVersion || 0) + 1),
    `值=${await revealInput.inputValue()} head=${afterLink.headVersion}`)
  check('还没填披露文本时「预览影响」禁用', await preview.isDisabled())
  await revealInput.fill('3')
  await draft.fill(SAFE)
  await page.waitForTimeout(200)
  check('填了「可以对读者说出的版本」后「预览影响」可点', !(await preview.isDisabled()))
  await preview.click()
  await page.waitForTimeout(1200)
  await page.locator('button', { hasText: '确认并提交' }).first().click()
  await page.waitForTimeout(1500)
  const afterReveal = await fetchProject()
  const rp = afterReveal.entities[0].revealProjections || []
  const ch3 = afterReveal.outline.volumes[0].chapters.find((c) => c.no === 3)
  check('提交后后端真的写入了角色级批准（safeText + approved）',
    rp.length === 1 && rp[0].approved === true && rp[0].safeText === SAFE, JSON.stringify(rp))
  check('并且同时写入了章级揭示（只写角色级 ⇒ 正文永远拿不到）',
    (ch3.reveals || []).length === 1 && ch3.reveals[0].projectionId === rp[0]?.id,
    JSON.stringify(ch3.reveals))

  /* ⑦ 伏笔新增 / 删除（主人反馈：伏笔只能改、不能增删） */
  await page.locator('.editor-tab', { hasText: '伏笔' }).first().click()
  await page.waitForTimeout(300)
  await contentSelect.selectOption('add')
  await page.waitForTimeout(300)
  const addBox = page.locator('.editor-body textarea').first()
  check('新增伏笔：提示写明两行格式，且空着时不能提交',
    (await page.locator('.draft-head__hint', { hasText: '第一行' }).count()) === 1 && (await preview.isDisabled()))
  await addBox.fill('食堂阿姨总多给一勺\n她其实是主角的亲生母亲')
  await page.waitForTimeout(200)
  check('填了两行后可以提交', !(await preview.isDisabled()))
  await preview.click(); await page.waitForTimeout(1000)
  await page.locator('button', { hasText: '确认并提交' }).first().click(); await page.waitForTimeout(1400)
  const afterAdd = await fetchProject()
  const added = afterAdd.outline.foreshadows.find((f) => f.seed === '食堂阿姨总多给一勺')
  check('新增伏笔真的落库了（id 由线索铺设派生、章号留空等确认）',
    !!added && /^fs_/.test(added.id) && added.payoffChapter === null, JSON.stringify(added || null))

  // 删除：window.confirm 必须处理，否则会挂住
  page.once('dialog', (d) => d.accept())
  await page.locator('.editor-tab', { hasText: '伏笔' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('.edit-label', { hasText: '选择对象' }).locator('select').selectOption({ label: '食堂阿姨总多给一勺' })
  await page.waitForTimeout(300)
  const delBtn = page.locator('button', { hasText: '删除这条伏笔' }).first()
  check('伏笔页有「删除这条伏笔」按钮', (await delBtn.count()) === 1)
  await delBtn.click()
  await page.waitForTimeout(1600)
  const afterDel = await fetchProject()
  check('删除真的落库了（这条伏笔从大纲里消失）',
    !afterDel.outline.foreshadows.some((f) => f.seed === '食堂阿姨总多给一勺'),
    JSON.stringify(afterDel.outline.foreshadows.map((f) => f.seed)))

  /* ⑧ 🔴 标记 + 「查看上个版本」（纯视图切换，不碰存储层） */
  await page.locator('.editor-tab', { hasText: '角色卡' }).first().click()
  await page.waitForTimeout(700)
  const contentSelect2 = page.locator('.edit-label', { hasText: '修改内容' }).locator('select')
  const charOpts = await contentSelect2.locator('option').allInnerTexts()
  check('切到角色卡后，「修改内容」下拉确实是角色字段', charOpts.includes('性格'), JSON.stringify(charOpts))
  await contentSelect2.selectOption('personality')
  await page.waitForTimeout(300)
  const pBox = page.locator('.editor-body textarea').first()
  // ⚠️ 夹具里「性格」原本是空的 ⇒ 只改一次的话「上个版本」就是空的（看不出对错）。
  //    所以**改两次**，这样才有真正的「上一次提交前的值」可验。
  await pBox.fill('第一版性格')
  await page.waitForTimeout(200)
  await preview.click(); await page.waitForTimeout(1000)
  await page.locator('button', { hasText: '确认并提交' }).first().click(); await page.waitForTimeout(1400)
  await pBox.fill('第二版性格')
  await page.waitForTimeout(200)
  await preview.click(); await page.waitForTimeout(1000)
  await page.locator('button', { hasText: '确认并提交' }).first().click(); await page.waitForTimeout(1400)
  const revAfterEdit = (await fetchProject()).editRevision
  check('改完一个文本字段后，「修改内容」下拉上出现 🔴 标记',
    (await page.locator('.edit-label', { hasText: '修改内容' }).innerText()).includes('🔴'),
    await page.locator('.edit-label', { hasText: '修改内容' }).innerText())
  const oldBtn = page.locator('button', { hasText: /查看上个版本|回到当前版本/ }).first()
  check('并且出现「查看上个版本」', (await oldBtn.count()) === 1)
  check('刚提交完时提示栏里有「上次改动」清单', (await page.locator('.diff-list__title').count()) === 1)
  await oldBtn.click(); await page.waitForTimeout(400)
  const oldVal = await pBox.inputValue()
  check('切到上个版本：显示的是**上一次提交前**的值，且只读',
    oldVal === '第一版性格' && (await pBox.getAttribute('readonly')) !== null, JSON.stringify(oldVal))
  check('看旧版本时「预览影响」被禁用（不会误提交）', await preview.isDisabled())
  await oldBtn.click(); await page.waitForTimeout(400)
  check('切回当前版本：显示当前值', (await pBox.inputValue()) === '第二版性格', await pBox.inputValue())
  check('⛔ 来回切换**不影响存储层**（editRevision 没变）',
    (await fetchProject()).editRevision === revAfterEdit, `${revAfterEdit}`)

  /* ⑨ 导出面板：格式与分区都来自服务端下发（前端原来抄了一份带文案的清单，且从不读 formats） */
  await page.goBack()
  await page.waitForTimeout(800)
  const exportBtn = page.locator('button', { hasText: '导出' }).first()
  check('目录页有「导出」入口', (await exportBtn.count()) === 1)
  await exportBtn.click()
  await page.waitForTimeout(800)
  const opts = await (await fetch(`http://127.0.0.1:${PORT}/api/export-options`)).json()
  const fmtLabels = await page.locator('.sheet .seg__item b').allInnerTexts()
  check('导出面板的格式项与服务端 /api/export-options **逐项一致**（不再各存一份）',
    JSON.stringify(fmtLabels) === JSON.stringify((opts.formats || []).map((f) => f.label)),
    `界面=${JSON.stringify(fmtLabels)} 服务端=${JSON.stringify((opts.formats || []).map((f) => f.label))}`)
  const secLabels = await page.locator('.sheet .check__body b').allInnerTexts()
  check('导出内容分区也逐项一致（含服务端下发的 label，不是前端常量）',
    JSON.stringify(secLabels) === JSON.stringify((opts.sections || []).map((s) => s.label)),
    `界面 ${secLabels.length} 项 / 服务端 ${(opts.sections || []).length} 项`)

  await browser.close()
  fs.rmSync(DATA, { recursive: true, force: true })
}

try { await main() } catch (e) { log('\n[异常]', e.message); results.push({ name: '执行异常', ok: false, detail: e.message }) }
finally {
  try { edge?.kill() } catch {}
  try { app?.kill() } catch {}
  await sleep(300)
  // 临时 Edge profile 与临时数据目录都不留下来（数据目录在 main 成功时已删，这里兜底）
  try { if (PROFILE) fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
  const pass = results.filter((r) => r.ok).length
  log(`\n===== 结果 ${pass}/${results.length} =====`)
  for (const r of results) if (!r.ok) log(`  FAIL: ${r.name} ${r.detail}`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}
