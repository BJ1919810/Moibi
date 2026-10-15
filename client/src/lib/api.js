/**
 * 前端与后端的唯一通道。
 *
 * 两种运行形态，对页面完全透明：
 *   ① **桌面服务 / 局域网**：走同源 fetch('/api/...')，密钥与编排在电脑上的 Node 里；
 *   ② **App 内独立**：后端逻辑已编进本 bundle，直接函数调用（不出设备、不联网）。
 *
 * 判定方式：由 `VITE_MOBI_LOCAL=1` 在构建期决定（App 用本地模式）。
 * 两条路径的**返回值结构、错误文案完全一致**，因此页面代码无需感知差异。
 *
 * 密钥永远不经过前端存储 —— 本地模式下它存在 App 自己的 localStorage 里，
 * 由后端逻辑（store.js）读写，页面同样读不到明文。
 */

const TOKEN_KEY = 'mobi_token'

/* ------------------------- 运行模式判定 ------------------------- */

/**
 * 构建期常量：App 构建（vite build --mode app + .env.app）会设 VITE_MOBI_LOCAL=1。
 *
 * ⚠️ 这里刻意写成 `import.meta.env.VITE_MOBI_LOCAL === '1'` 的**字面量比较**，
 * 而不是读一个变量：Vite 会在构建时把 `import.meta.env.VITE_MOBI_LOCAL` 替换成
 * 字面量 `undefined`/`'1'`，Rollup 随即能把整个分支**静态摇掉**。
 * 效果：网页版（桌面/局域网）的产物里**完全不含**后端代码 —— 少 120KB+。
 * 若改成动态读取（如 `import.meta.env[name]`），替换失效，后端会被无条件打进网页版。
 */
export const LOCAL_MODE = import.meta.env.VITE_MOBI_LOCAL === '1'

let backendPromise = null
/** 懒加载本地后端（仅 App 构建会保留这段代码） */
function localBackend() {
  if (!backendPromise) {
    backendPromise = import('../backend/app.js')
  }
  return backendPromise
}

;(function captureToken() {
  try {
    const url = new URL(window.location.href)
    const t = url.searchParams.get('t')
    if (t) {
      localStorage.setItem(TOKEN_KEY, t)
      url.searchParams.delete('t')
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    }
  } catch {
    /* 非浏览器环境或无 localStorage，忽略 */
  }
})()

function token() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

async function req(path, options = {}) {
  // 本地模式：直接调用内置后端，不经过 HTTP
  if (LOCAL_MODE) {
    const { call } = await localBackend()
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : {}
    const [purePath, search] = String(path).split('?')
    return call(purePath, { method, body, query: search ? new URLSearchParams(search) : null })
  }

  const t = token()
  let res
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(t ? { 'X-Mobi-Token': t } : {}),
        ...(options.headers || {}),
      },
    })
  } catch {
    throw new Error('连不上后端服务，请确认服务正在运行。')
  }
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (res.status === 401) {
    throw new Error('访问被拒绝：请用电脑启动窗口里打印的「手机」地址重新打开一次。')
  }
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`)
  return data
}

export const api = {
  health: () => req('/api/health'),

  getConfig: () => req('/api/config'),
  saveConfig: (patch) => req('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
  testConfig: () => req('/api/config/test', { method: 'POST' }),

  listProjects: () => req('/api/projects'),
  createProject: (payload) => req('/api/projects', { method: 'POST', body: JSON.stringify(payload) }),
  getProject: (id) => req(`/api/projects/${id}`),
  deleteProject: (id) => req(`/api/projects/${id}`, { method: 'DELETE' }),
  replanFuture: (id, mode = 'full') => req(`/api/projects/${id}/replan`, { method: 'POST', body: JSON.stringify({ mode }) }),
  // 草稿预览与确认：严禁直接改正式项目字段。
  createChange: (id, change) => req(`/api/projects/${id}/changes`, {method:'POST',body:JSON.stringify(change)}),
  listChanges: (id) => req(`/api/projects/${id}/changes`),
  approveChange: (id) => req(`/api/changes/${id}/approve`, {method:'POST'}),
  rejectChange: (id) => req(`/api/changes/${id}/reject`, {method:'POST'}),
  regenerateOutline: (id, payload) =>
    req(`/api/projects/${id}/outline`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  // R4：非阻塞生成；所有后续操作都基于持久化 run_id，不依赖页面是否一直打开。
  writeChapter: (id, no, expectedHeadVersion = null) =>
    req(`/api/projects/${id}/runs`, { method: 'POST', body: JSON.stringify({ no, expectedHeadVersion }) }),
  proposeCreate: (payload) => req('/api/assistant/create', {method:'POST',body:JSON.stringify(payload)}),
  proposeProject: (id,payload) => req(`/api/projects/${id}/assistant`, {method:'POST',body:JSON.stringify(payload)}),
  replyAssistant: (id,message) => req(`/api/assistant/${id}/reply`, {method:'POST',body:JSON.stringify({message})}),
  listRuns: (id) => req(`/api/projects/${id}/runs`),
  getRun: (id) => req(`/api/runs/${id}`),
  getRunContext: (id) => req(`/api/runs/${id}/context`),
  resumeRun: (id) => req(`/api/runs/${id}/resume`, { method: 'POST' }),
  cancelRun: (id) => req(`/api/runs/${id}/cancel`, { method: 'POST' }),
  acceptRun: (id) => req(`/api/runs/${id}/accept`, { method: 'POST' }),

  // 导出面板会直接用 <a download> 打开这个地址，因此两种模式要给出**可用地址**：
  //   桌面/局域网：指向同源 HTTP 导出接口（带口令，`<a>` 带不了请求头）。
  //   App 内独立：后端不在网络里，改为现取内容生成 blob: 地址。
  exportUrl: (id, options = {}) => {
    if (!LOCAL_MODE) {
      const q = new URLSearchParams()
      const t = token()
      if (t) q.set('t', t)
      if (options.format) q.set('format', options.format)
      if (options.parts?.length) q.set('parts', options.parts.join(','))
      const s = q.toString()
      return `/api/projects/${id}/export${s ? `?${s}` : ''}`
    }
    // 本地模式：同步签名的占位地址会被调用方替换，见 exportBlobUrl
    const q = new URLSearchParams()
    if (options.format) q.set('format', options.format)
    if (options.parts?.length) q.set('parts', options.parts.join(','))
    const s = q.toString()
    return `#local-export:${id}${s ? `?${s}` : ''}`
  },

  /**
   * 本地模式下取得可下载的 blob: 地址（异步）。
   * 页面若无脑用 exportUrl 的结果当 href，会在本地模式下拿到 `#local-export:...`；
   * 因此本地模式请改用本方法。导出面板已做分支。
   */
  exportBlobUrl: async (id, options = {}) => {
    if (!LOCAL_MODE) return api.exportUrl(id, options)
    const { call } = await localBackend()
    const q = new URLSearchParams()
    if (options.format) q.set('format', options.format)
    if (options.parts?.length) q.set('parts', options.parts.join(','))
    const file = await call(`/api/projects/${id}/export`, {
      method: 'GET',
      query: q.toString() ? q : null,
    })
    const blob = new Blob([file.body], { type: `${file.mime};charset=utf-8` })
    return { url: URL.createObjectURL(blob), filename: file.filename }
  },

  // 导出可选的格式与内容分区（后端为单一事实来源，前端另有兜底）
  getExportOptions: () => req('/api/export-options'),
}

/** 把模型返回的长文本按空行切成段落 */
export function toParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
