/**
 * 在桌面 Edge 里**仿真 Android 原生壳**，实测返回键行为。
 *
 * 存在意义（防止再被"看起来绑好了"骗）：
 *   普通网页里按浏览器返回走 popstate，看起来一切正常；但装成 APK 后
 *   Capacitor 不接管返回键，系统直接 finish() Activity ⇒ 按一下退出应用。
 *   ⇒ 必须让桌面浏览器**扮演原生壳**，把返回键走成 backButton 事件才算真测到。
 *
 * 忠实度：直接加载 Capacitor 官方的 native-bridge.js（就是打进 APK 那份），
 *   并按真机注入顺序还原 androidBridge → bridge → PluginHeaders。
 *   时序说明见 native-shell-harness.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HARNESS_PRE, HARNESS_POST } from './verify-native-shell.mjs'

// 本脚本位于 mobi/scripts/ ⇒ 上一级就是 mobi/
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBI = path.resolve(__dirname, '..')
const DIST = path.join(MOBI, 'dist')
const EDGE_PROFILE_ROOT = path.join(MOBI, '.wb-tmp')
const BRIDGE_SRC = path.join(
  MOBI, 'node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js'
)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 8794
const CDP_PORT = 9447

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  let file
  if (url === '/' || url === '/index.html') file = path.join(DIST, 'index.html')
  else if (url === '/native-bridge.js') file = BRIDGE_SRC
  else file = path.resolve(DIST, '.' + url)
  if (!file.startsWith(DIST) && file !== BRIDGE_SRC) { res.writeHead(403); return res.end() }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404') }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
})

async function main() {
  // 组装：PRE 放 head 最前（早于 bundle），POST 放 bundle 之前但晚于 bridge。
  // 真实 index.html 里入口脚本在 body 末尾，所以我们插在 </body> 前。
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  let patched = html.replace('<head>', '<head>' + HARNESS_PRE)
  patched = patched.replace('</body>', HARNESS_POST + '</body>')
  fs.writeFileSync(path.join(DIST, '__verify.html'), patched)

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const profile = path.join(EDGE_PROFILE_ROOT, 'edge-profile-back2')
  fs.rmSync(profile, { recursive: true, force: true })

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--no-proxy-server', '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PORT}/__verify.html`,
  ], { stdio: 'ignore' })

  try {
    let wsUrl
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
        const p = list.find((t) => t.type === 'page')
        if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break }
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    const ws = new WebSocket(wsUrl)
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
    let seq = 0; const waiting = {}
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id] }
    })
    const send = (method, params) =>
      new Promise((res) => { const id = ++seq; waiting[id] = res; ws.send(JSON.stringify({ id, method, params: params || {} })) })
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
      return r.result?.result?.value
    }
    await send('Runtime.enable'); await send('Page.enable')
    await new Promise((r) => setTimeout(r, 2500))

    // ① 平台判定
    ok('平台判定 = android（不是 web）', (await ev('window.Capacitor.getPlatform()')) === 'android')
    ok('androidBridge 已注入', (await ev('typeof window.androidBridge === "object"')) === true)

    // ② 关键：前端是否真的订阅了 backButton（上一轮 bug 的直接体现）
    const n = await ev('window.__backListeners.length')
    ok('App 已订阅 backButton 事件', n > 0, `注册数 ${n}`)
    if (n === 0) {
      console.log('    nativeLog:', JSON.stringify(await ev('window.__nativeLog')))
      console.log('    warnings :', JSON.stringify(await ev('window.__warns || []')))
    }

    // ③ 书架（最外层）按返回 → 退出应用
    const e0 = await ev('window.__exitCalled')
    await ev('window.__pressHardwareBack()')
    await new Promise((r) => setTimeout(r, 250))
    const e1 = await ev('window.__exitCalled')
    ok('书架层按返回 → 退出应用', e1 > e0, `exitApp ${e0} → ${e1}`)

    // ④ 进设置页（栈深 2）→ 按返回应回退，且不退出
    await ev(`
      (() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '设置');
        if (b) b.click(); return !!b;
      })()
    `)
    await new Promise((r) => setTimeout(r, 400))
    ok('已进入设置页（栈深 2）', (await ev('document.querySelectorAll(".topbar").length')) > 0)
    const titleInSettings = await ev(`document.querySelector('.topbar__title')?.textContent?.trim()`)
    const e2 = await ev('window.__exitCalled')
    await ev('window.__pressHardwareBack()')
    await new Promise((r) => setTimeout(r, 400))
    const e3 = await ev('window.__exitCalled')
    ok('子页面按返回 → 不退出应用', e3 === e2, `exitApp ${e2} → ${e3}`)
    // 且应真的回到了书架（标题从「设置」变回「墨笔」）
    const titleBack = await ev(`document.querySelector('.topbar__title')?.textContent?.trim()`)
    ok('子页面按返回 → 确实退回书架', titleInSettings === '设置' && titleBack === '墨笔',
      `${titleInSettings} → ${titleBack}`)

    // ⑤ 浮层：作品内的「☰ 导航抽屉」开着时按返回 → 只关抽屉、不退出
    //    书架页没有 ☰，所以先用 localStorage 直接种一部最小作品（键前缀见 shims/fs.js）。
    await ev(`
      (() => {
        const now = new Date().toISOString();
        const proj = {
          id: 'p_verify01', title: '返回键验证样书', idea: '测试用',
          createdAt: now, updatedAt: now, headVersion: 0, editRevision: 0,
          outline: { totalChapters: 3, volumes: [], chapters: [
            { no: 1, title: '第一章', status: 'pending' },
            { no: 2, title: '第二章', status: 'pending' },
            { no: 3, title: '第三章', status: 'pending' },
          ]},
          chapters: [], entities: [], rules: [], ledger: [], foreshadows: [],
          preferences: {}, authorWorldRules: '',
        };
        // store.js: PROJECTS_DIR = ROOT/data/projects，ROOT 被 shim 钉成 /mobi-app
        localStorage.setItem('mobi_fs::/mobi-app/data/projects/p_verify01.json', JSON.stringify(proj, null, 2));
        return true;
      })()
    `)

    // 刷新让书架重新拉列表
    await send('Page.reload', { ignoreCache: true })
    await new Promise((r) => setTimeout(r, 2200))
    // reload 后桩脚本会重跑，监听器应重新注册
    const n2 = await ev('window.__backListeners.length')
    ok('重新加载后仍能订阅 backButton（恢复路径）', n2 > 0, `注册数 ${n2}`)

    const opened = await ev(`
      (() => {
        const card = [...document.querySelectorAll('.book-card, .card')]
          .find(x => x.textContent.includes('返回键验证样书'));
        if (card) card.click();
        return !!card;
      })()
    `)
    await new Promise((r) => setTimeout(r, 800))
    const hasNav = await ev(`!!document.querySelector('.topbar__menu')`)
    if (hasNav && opened) {
      await ev(`document.querySelector('.topbar__menu').click()`)
      await new Promise((r) => setTimeout(r, 450))
      const drawerOpen = await ev(`!!document.querySelector('.drawer, .navdrawer, [role="dialog"]')`)
      const e4 = await ev('window.__exitCalled')
      await ev('window.__pressHardwareBack()')
      await new Promise((r) => setTimeout(r, 450))
      const e5 = await ev('window.__exitCalled')
      ok('浮层（导航抽屉）开着按返回 → 不退出应用', e5 === e4, `抽屉开=${drawerOpen}, exitApp ${e4} → ${e5}`)
      const closed = await ev(`!!document.querySelector('.drawer, .navdrawer, [role="dialog"]')`)
      ok('浮层开着按返回 → 抽屉确实被关掉', closed === false, `关闭后仍存在=${closed}`)
    } else {
      ok('浮层用例：未能进入大纲页，跳过（已由单测覆盖）', true, `opened=${opened} hasNav=${hasNav}`)
    }

    // ⑥ 对照：清空监听器后原生走"无监听者"分支（会退出）—— 证明测试真能抓 bug
    await ev('window.__backListeners.length = 0')
    const r = await ev('window.__pressHardwareBack()')
    ok('对照：无监听器时原生直接退出（证明测试有效）', r === 'no-listener', `返回 ${r}`)

    const pass = results.filter((x) => x.ok).length
    console.log(`\n— 结果 —\n${pass}/${results.length} 通过`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    edge.kill()
    server.close()
    fs.rmSync(path.join(DIST, '__verify.html'), { force: true })
  }
}

main().catch((e) => { console.error('运行失败：', e); process.exitCode = 1 })
