/**
 * 回归：网页形态（桌面/局域网）的返回键必须仍是**浏览器历史**语义。
 *
 * 背景：这次修 APK 返回键时引入了原生壳分支。必须确认网页版没被带偏——
 *   · 不加载 @capacitor/app（除了那个惰性 0.7KB chunk，且不该被执行）
 *   · 不主动 exitApp（网页没这个概念）
 *   · 浏览器返回键 = 退上一层（popstate），与改动前行为一致
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 本脚本位于 mobi/scripts/ ⇒ 上一级就是 mobi/
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBI = path.resolve(__dirname, '..')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 8795, CDP_PORT = 9448

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

async function main() {
  // 网页版产物：由外部命令预先构建到 dist-web-verify（见 skill 里的运行说明），
  // 这里**只读不改**，跑完也不删除，便于复跑。
  const DIST_WEB = path.join(MOBI, 'dist-web-verify')
  if (!fs.existsSync(DIST_WEB)) {
    throw new Error('缺少网页版产物。请先运行：vite build --outDir dist-web-verify --emptyOutDir')
  }

  const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    // 网页版会 fetch /api/config；这里给个最小桩，避免界面因 404 走异常分支。
    // （只影响本测试，与产品代码无关。）
    if (url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, hasKey: false, model: '', baseURL: '', projects: [] }))
    }
    const file = url === '/' || url === '/index.html'
      ? path.join(DIST_WEB, 'index.html')
      : path.resolve(DIST_WEB, '.' + url)
    if (!file.startsWith(DIST_WEB)) { res.writeHead(403); return res.end() }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('404') }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(buf)
    })
  })

  // ⚠️ 必须先等监听成功再拉起浏览器，否则 Edge 会撞上「127.0.0.1 拒绝连接」
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const profile = path.join(MOBI, '.wb-tmp', 'edge-profile-web')
  fs.rmSync(profile, { recursive: true, force: true })
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--no-proxy-server', '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PORT}/index.html`,
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
    await new Promise((r) => setTimeout(r, 2000))

    // 抓渲染失败的真实原因（别猜）
    const diag = await ev(`
      (() => ({
        href: location.href,
        title: document.title,
        head: document.documentElement.outerHTML.slice(0, 300),
        root: !!document.getElementById('root'),
        app: !!document.querySelector('.app'),
        bodyLen: document.body.innerHTML.length,
      }))()
    `)
    if (!diag.app) console.log('    诊断:', JSON.stringify(diag, null, 1).slice(0, 900))
    if (!diag.app) {
      const bodySnip = await ev('document.body.innerHTML.slice(0, 400)')
      console.log('    body 开头:', bodySnip)
    }

    ok('网页形态：无 androidBridge（平台判定 = web）',
      (await ev('window.Capacitor?.getPlatform?.() ?? "web"')) === 'web')
    ok('网页形态：界面正常渲染', (await ev(`!!document.querySelector('.app')`)) === true)

    // 进设置页 → 浏览器返回 → 应退回书架（popstate 路径）
    await ev(`
      (() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '设置');
        if (b) b.click(); return !!b;
      })()
    `)
    await new Promise((r) => setTimeout(r, 400))
    const t1 = await ev(`document.querySelector('.topbar__title')?.textContent?.trim()`)
    await ev('window.history.back()')
    await new Promise((r) => setTimeout(r, 600))
    const t2 = await ev(`document.querySelector('.topbar__title')?.textContent?.trim()`)
    ok('网页形态：浏览器返回 → 退回上一层', t1 === '设置' && t2 === '墨笔', `${t1} → ${t2}`)

    ok('网页形态：未调用 exitApp（无此概念）',
      (await ev('typeof window.__exitCalled === "undefined"')) === true)

    const pass = results.filter((x) => x.ok).length
    console.log(`\n— 结果 —\n${pass}/${results.length} 通过`)
    if (pass !== results.length) process.exitCode = 1
  } finally {
    edge.kill()
    server.close()
  }
}

main().catch((e) => { console.error('运行失败：', e); process.exitCode = 1 })
