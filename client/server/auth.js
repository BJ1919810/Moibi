/**
 * 访问控制：纯函数，便于自动化测试。
 *
 * 设计：本机（运行服务的这台电脑）免检；其他设备必须携带正确口令。
 * 抽成纯函数是为了能被确定性测试覆盖 —— 内联在 HTTP 处理里会因
 * "本机永远免检"而无法测出拒绝路径。
 */
import crypto from 'node:crypto'

/** 把 IPv4-mapped IPv6（::ffff:192.168.1.5）归一成 IPv4 */
export function normalizeIp(raw) {
  let ip = String(raw || '')
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  return ip
}

const LOCAL_IPS = new Set(['127.0.0.1', '::1'])

export function isLocalIp(raw) {
  return LOCAL_IPS.has(normalizeIp(raw))
}

/** 恒定时间比较，避免通过响应耗时推断口令 */
export function checkToken(given, expected) {
  if (given === undefined || given === null || given === '') return false
  if (!expected) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(expected))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * @param {object} p
 * @param {string} p.remoteAddress  请求来源 IP
 * @param {string} [p.headerToken]  X-Mobi-Token 头
 * @param {string} [p.queryToken]   ?t= 查询参数（供 <a> 直接下载等场景）
 * @param {string} p.expected       服务端持有的正确口令
 */
export function isAuthorized({ remoteAddress, headerToken, queryToken, expected }) {
  if (isLocalIp(remoteAddress)) return true
  return checkToken(headerToken || queryToken, expected)
}

/**
 * 同源校验（第 2 轮评审问题 7）。
 *
 * 「回环地址免口令」本身没问题，危险的是它与「CORS 全开放」叠加：
 * 本机浏览器里的任意网站都能跨源打到 127.0.0.1:8787，走免鉴权路径读作品、
 * 甚至触发付费生成。
 *
 * 修法：**不再返回任何 Access-Control-Allow-* 头**（前端与 API 同源，本就不需要 CORS），
 * 并对 API 请求校验 Origin 与 Host 是否一致。
 *
 * Origin 缺失时放行 —— 浏览器发起的跨源请求**必然**携带 Origin，
 * 而 curl / 脚本 / 同源导航不带。所以「有 Origin 就必须校验」已经覆盖了攻击面，
 * 同时不会误伤命令行调用。
 *
 * @returns {{ok: boolean, reason: string}}
 */
export function checkOrigin({ origin, host }) {
  if (origin === undefined || origin === null || origin === '') {
    return { ok: true, reason: 'no-origin-header' }
  }
  // 文件协议 / 沙箱 iframe 会发 "null"。墨笔前端由本服务托管，永远不该出现。
  if (origin === 'null') return { ok: false, reason: 'opaque-origin' }

  let parsed
  try {
    parsed = new URL(String(origin))
  } catch {
    return { ok: false, reason: 'malformed-origin' }
  }

  const targetHost = String(host || '').toLowerCase().trim()
  if (!targetHost) return { ok: false, reason: 'missing-host' }

  // 逐字比较 host（含端口）—— 同源的严格定义
  if (parsed.host.toLowerCase() === targetHost) return { ok: true, reason: 'same-origin' }
  return { ok: false, reason: 'cross-origin' }
}

/**
 * Host 头白名单 —— **DNS rebinding 的唯一有效防线**。
 *
 * ⛔ 先纠正一个常见误解（我自己也一度这么写）：Origin 与 Host 比对**挡不住** DNS rebinding。
 *    攻击是这样发生的：
 *      ① 用户在 `http://evil.com:8787` 打开攻击者的页面（攻击者自己就能在 8787 端口托管）；
 *      ② 页面里的 JS 请求 `http://evil.com:8787/api/...` —— 对浏览器而言**同源**，
 *         所以既不发 `Origin`（GET）也不触发 CORS 预检；
 *      ③ evil.com 的 DNS 到期后重新解析到 127.0.0.1 ⇒ 请求打到用户本机的墨笔服务上，
 *         而 `Host: evil.com:8787`、`Origin` 缺失 ⇒ `checkOrigin` 放行 ⇒ 作品与付费生成全部暴露。
 *    ⇒ 真正有效的是**校验 Host 头**：只接受本机名/回环/局域网/单标签主机名。
 *    `checkOrigin` 仍然保留 —— 它挡的是另一半（**CSRF**：跨源页面向 127.0.0.1 发请求时
 *    `Origin: evil.com` 而 `Host: 127.0.0.1`，两者不一致）。
 *
 * 会不会误伤真实用法（这是我最担心的）：
 *   · 手机浏览器访问 `http://192.168.x.x:8787` ⇒ Host 是局域网 IP ⇒ **放行** ✓
 *   · `http://mybox:8787` / `http://DESKTOP-ABC:8787` ⇒ 单标签 ⇒ **放行** ✓
 *     （公开 DNS 解析不了单标签名，攻击者拿不到这种域名，所以放行它是安全的）
 *   · `xxx.local`（mDNS）⇒ 放行 ✓
 *   · 反代/公网域名 `novel.example.com` ⇒ **默认拒绝**，但可用 `MOBI_ALLOWED_HOSTS=novel.example.com`
 *     显式放行 —— 想公开暴露的人自己会说清楚。
 *   · App（Capacitor 离线形态）不发 HTTP，与此无关。
 *
 * @param {string} host 原始 Host 头（可能带端口，IPv6 形如 [::1]:8787）
 * @param {{extra?: string[]}} [opts] 额外显式放行的主机名
 * @returns {{ok: boolean, reason: string, name: string}}
 */
export function checkHost(host, { extra = [] } = {}) {
  const raw = String(host || '').trim().toLowerCase()
  if (!raw) return { ok: false, reason: 'missing-host', name: '' }
  // 去端口：IPv6 是 [::1]:8787 这种形状
  let name = raw
  const v6 = raw.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (v6) name = v6[1]
  else if (/^[^:]+:\d+$/.test(raw)) name = raw.slice(0, raw.lastIndexOf(':'))

  const allow = (reason) => ({ ok: true, reason, name })
  const deny = (reason) => ({ ok: false, reason, name })

  if (!name) return deny('empty-host')
  if (name === 'localhost' || name === '::1') return allow('loopback')
  if (/^127\./.test(name)) return allow('loopback')
  // 局域网私有段：10/8、192.168/16、172.16–172.31
  if (/^10\./.test(name) || /^192\.168\./.test(name) || /^172\.(1[6-9]|2\d|3[01])\./.test(name)) return allow('private-ip')
  if (name.endsWith('.local')) return allow('mdns')
  // 单标签主机名（mybox / DESKTOP-ABC）：公开 DNS 解析不了，攻击者拿不到
  if (!name.includes('.')) return allow('single-label')
  const extraList = (extra || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
  if (extraList.includes(name)) return allow('explicitly-allowed')
  return deny('host-not-allowed')
}

/** 从环境变量读显式放行的主机名（逗号分隔）：用于反代/自建域名等有意公开的场景 */
export function allowedHostsFromEnv(env = process.env) {
  return String(env.MOBI_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}
