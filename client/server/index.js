/**
 * 墨笔后端服务（零运行时依赖，仅用 Node 内置模块）。
 *
 * 职责（对应工程规划文档 §12）：
 *   - API：项目、大纲、章节、配置、导出
 *   - 持有模型密钥（前端永远拿不到明文）
 *   - 局域网访问控制：本机免检，其他设备需携带访问令牌（逻辑见 auth.js）
 *   - 生产模式下同时托管前端静态产物（dist/），使手机端只需访问一个地址
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'
import * as pipeline from './pipeline.js'
import { testConnection } from './providers/openai.js'
import { isAuthorized, checkOrigin, checkHost, allowedHostsFromEnv } from './auth.js'
import { createWorkflow } from './workflow.js'
import { updateAuthorSettings } from './author-control.js'
import { createReplanService } from './replan.js'
import { createAssistantService } from './assistant.js'
import { normalizeGenreTags, validateChapterCount } from './creative-options.js'
import { createChangeService } from './change-request.js'
import { createApiRouter } from './api-router.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8787)
const ACCESS_TOKEN = store.getAccessToken()
const workflow = createWorkflow()
const replanner = createReplanService()
const assistant = createAssistantService()
const changes = createChangeService()

/* --------------------------------- 工具 --------------------------------- */

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(String(urlPath).split('?')[0])
  if (rel === '/') rel = '/index.html'

  let file = path.join(DIST, rel)
  // 目录穿越防护：必须判「是否真的在 DIST 之内」。
  // ⛔ `startsWith(path.resolve(DIST))` 少了分隔符 ⇒ 与 DIST **同前缀的兄弟目录**会被放行
  //    （实测 `/..%2fdist-web-verify/index.html` 能读到另一个前端产物）。
  const relToDist = path.relative(path.resolve(DIST), path.resolve(file))
  if (relToDist.startsWith('..') || path.isAbsolute(relToDist)) {
    res.writeHead(403)
    return res.end('Forbidden')
  }
  // SPA 回退：找不到实体文件就交给 index.html
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('前端尚未构建。请先执行 npm run build。')
    }
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}

/* ------------------------------ 访问控制 ------------------------------ */

function requestAuthorized(req, url) {
  // ⛔ `?t=` 是**会随 URL 传播**的凭证（聊天记录、浏览器历史、服务器日志、Referer 都会漏），
  //    它只该服务于「点一下链接直接下载导出文件」这类**只读**场景。
  //    写操作（POST/DELETE，含触发付费生成）必须带 `X-Mobi-Token` 头 —— 前端本来就是这么发的
  //    （`src/lib/api.js` 把 URL 里的口令放进请求头），所以这条收紧不影响正常使用。
  const readOnly = req.method === 'GET' || req.method === 'HEAD'
  return isAuthorized({
    remoteAddress: req.socket.remoteAddress,
    headerToken: req.headers['x-mobi-token'],
    queryToken: readOnly ? url.searchParams.get('t') : null,
    expected: ACCESS_TOKEN,
  })
}

/* --------------------------------- 路由 --------------------------------- */

const apiRouter = createApiRouter({
  store,
  pipeline,
  workflow,
  replanner,
  assistant,
  changes,
  testConnection,
  validateChapterCount,
  normalizeGenreTags,
})

/**
 * HTTP 适配器：只做「读请求 → 调路由 → 写响应」。
 * 业务逻辑一律在 api-router.js 里，App 内本地适配器复用同一份。
 */
async function handleApi(req, res, p, url) {
  let body = {}
  if (req.method === 'POST' || req.method === 'DELETE') {
    body = await readBody(req)
  }
  const result = await apiRouter({ path: p, method: req.method, query: url.searchParams, body })

  // 导出：不走 JSON，直接作为附件下载
  if (result.file) {
    const encoded = encodeURIComponent(result.file.filename)
    res.writeHead(200, {
      'Content-Type': `${result.file.mime}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    })
    return res.end(result.file.body)
  }

  send(res, result.status, result.data)
}

/* --------------------------------- 启动 --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  const isApi = p.startsWith('/api/')

  // 同源校验（第 2 轮评审问题 7）。
  // 注意：这里**不设置任何 Access-Control-Allow-* 头** —— 前端与 API 同源，
  // 全开放 CORS 只会把「本机免口令」暴露给本机浏览器里的任意网站。
  //
  // ⛔ 但只做同源校验**挡不住 DNS rebinding**（攻击者可以在自己的 8787 端口上托管页面，
  //    于是请求对浏览器而言是同源、连 Origin 都不发）。所以先用 **Host 白名单**把
  //    「公开域名指向本机」这条路堵掉：只接受本机/回环/局域网/单标签主机名
  //    （或 MOBI_ALLOWED_HOSTS 里显式放行的）。详见 auth.checkHost 的注释。
  const hc = checkHost(req.headers.host, { extra: allowedHostsFromEnv() })
  if (!hc.ok && isApi) {
    return send(res, 403, {
      error: `请求的 Host（${req.headers.host || '（无）'}）不在允许范围内（${hc.reason}）。`
        + '墨笔只接受本机/局域网访问；如果确实要通过域名或反向代理使用，'
        + '请设置环境变量 MOBI_ALLOWED_HOSTS=你的域名 后重启。',
    })
  }
  if (isApi) {
    const oc = checkOrigin({ origin: req.headers.origin, host: req.headers.host })
    if (!oc.ok) {
      return send(res, 403, {
        error: `跨源请求被拒绝（${oc.reason}）。墨笔只接受同源访问。`,
      })
    }
  }

  // 同源请求不会触发 CORS 预检；能走到这里的预检一律是跨源的，前面已被拦下
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // 静态资源不鉴权：它只是空壳，不含任何数据；前端需要先加载才能带上口令
  if (!isApi) return serveStatic(res, p)

  if (!requestAuthorized(req, url)) {
    return send(res, 401, {
      error: '未授权：请用启动窗口里打印的「手机」地址访问，或在运行服务的这台电脑上操作。',
    })
  }

  try {
    await handleApi(req, res, p, url)
  } catch (err) {
    console.error('[api]', err)
    if (!res.headersSent) send(res, 500, { error: String(err?.message || err) })
  }
})

// 生成一章可能数分钟，禁用默认请求超时
server.timeout = 0
server.requestTimeout = 0
server.headersTimeout = 0

server.listen(PORT, '0.0.0.0', () => {
  // 仅恢复确实排队、尚未发出模型请求的任务；不确定的外部调用不自动重发。
  for (const run of store.listRuns()) {
    if (run.status === 'queued' || (run.status === 'planning' && run.step !== 'l2-call')) {
      const actor = run.type === 'replan' ? replanner : workflow
      void actor.process(run.id).catch((err) => console.error('[startup-resume]', err))
    } else if (run.status === 'writing' || run.status === 'extracting' || run.step === 'l2-call') {
      const actor = run.type === 'replan' ? replanner : workflow
      void actor.process(run.id).catch((err) => console.error('[startup-uncertain]', err))
    }
  }
  const cfg = store.publicConfig()
  const nets = os.networkInterfaces()
  const lan = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)

  console.log('')
  console.log('  墨笔 · 服务已启动')
  console.log('  ─────────────────────────────────────────')
  console.log(`  本机   http://127.0.0.1:${PORT}`)
  for (const ip of lan) {
    console.log(`  手机   http://${ip}:${PORT}/?t=${ACCESS_TOKEN}`)
  }
  console.log('')
  console.log('  手机地址带访问口令，等同钥匙，请勿外传。')
  console.log('  同一 WiFi 的其他设备若不带口令，会被拒绝。')
  console.log(`  模型   ${cfg.model}  ${cfg.hasKey ? '已配置密钥' : '【尚未配置密钥】'}`)
  console.log('')
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('  提示：前端尚未构建，请先执行 npm run build')
    console.log('')
  }
})
