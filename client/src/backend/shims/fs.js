/**
 * `node:fs` 的浏览器替代实现。
 *
 * 墨笔 `store.js` 用的是**同步**文件 API（readFileSync / writeFileSync /
 * readdirSync / existsSync / mkdirSync / unlinkSync / renameSync / copyFileSync /
 * statSync / createReadStream）。真实浏览器里没有同步文件系统，同步 IndexedDB
 * 也不存在。⇒ 用一个 **内存文件系统 + localStorage 落盘** 的同步实现顶上。
 *
 * 设计要点
 *   - 全部数据以「路径 → 文本」存进 localStorage（写入即落盘，同步、可靠）；
 *   - 打印/调试用的 console 输出保留（换行折叠成一行，免得刷屏）；
 *   - 只实现后端真正用到的方法；未实现的一律抛错，**不静默返回空值**
 *     （静默失败会让「作品凭空消失」这类问题极难排查）。
 *
 * 容量：localStorage 一般 5~10MB。作品 JSON 约 60KB，够存数十本；
 * 逼近上限时写入会抛 QuotaExceededError，由调用方决定如何提示。
 */
import path from './path.js'

const PREFIX = 'mobi_fs::'

/** 路径 → 文本 的镜像缓存，避免每次读都过一遍 localStorage */
let cache = null

function loadAll() {
  if (cache) return cache
  cache = new Map()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) cache.set(k.slice(PREFIX.length), localStorage.getItem(k))
    }
  } catch {
    /* 无 localStorage（如 SSR / 隐私模式）：退化成纯内存 */
  }
  return cache
}

const norm = (p) => path.resolve(String(p))

function readRaw(file) {
  const key = norm(file)
  const all = loadAll()
  if (all.has(key)) return all.get(key)
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${key}'`), { code: 'ENOENT' })
}

function writeRaw(file, text) {
  const key = norm(file)
  loadAll().set(key, text)
  try {
    localStorage.setItem(PREFIX + key, text)
  } catch (err) {
    // 容量超限：回滚内存缓存，保证内存与落盘一致
    loadAll().delete(key)
    throw Object.assign(new Error('本地存储已满，无法保存。请删除部分作品后重试。'), { code: 'ENOSPC' })
  }
}

function each(prefix, opts) {
  const base = norm(prefix)
  const out = []
  for (const key of loadAll().keys()) {
    if (!key.startsWith(base)) continue
    let rest = key.slice(base.length)
    if (rest.startsWith('/')) rest = rest.slice(1)
    if (!rest) continue
    if (opts.recursive) {
      out.push(rest)
      continue
    }
    // 虚拟文件系统里目录是隐式的（由文件路径推导），所以取第一段即可：
    // 是文件就返回文件名，是子目录就返回目录名 —— 与真实 readdir 语义一致。
    out.push(rest.split('/')[0])
  }
  return [...new Set(out)]
}

/* ------------------------------ 同步 API ------------------------------ */

export function readFileSync(file, enc) {
  const text = readRaw(file)
  if (enc === 'utf8' || enc === 'utf-8' || enc === undefined) return text
  return new TextEncoder().encode(text)
}

export function writeFileSync(file, data, enc) {
  writeRaw(file, typeof data === 'string' ? data : new TextDecoder().decode(data))
}

export function appendFileSync(file, data) {
  let prev = ''
  try { prev = readRaw(file) } catch { /* 文件不存在则从空开始 */ }
  writeRaw(file, prev + String(data))
}

export function existsSync(file) {
  return loadAll().has(norm(file))
}

export function mkdirSync() {
  // 虚拟文件系统里目录是隐式的（由文件路径推导），无需真实创建
}

export function readdirSync(dir) {
  return each(dir, { recursive: false })
}

export function unlinkSync(file) {
  const key = norm(file)
  if (!loadAll().has(key)) {
    throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${key}'`), { code: 'ENOENT' })
  }
  loadAll().delete(key)
  try { localStorage.removeItem(PREFIX + key) } catch { /* 忽略 */ }
}

export function renameSync(from, to) {
  const src = norm(from)
  const dst = norm(to)
  const all = loadAll()
  const text = all.get(src)
  if (text === undefined) {
    throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${src}'`), { code: 'ENOENT' })
  }
  all.delete(src)
  try { localStorage.removeItem(PREFIX + src) } catch { /* 忽略 */ }
  writeRaw(dst, text)
}

export function copyFileSync(from, to) {
  writeRaw(to, readRaw(from))
}

export function statSync(file) {
  const text = readRaw(file)
  return {
    size: text.length,
    isDirectory: () => false,
    isFile: () => true,
    mtime: new Date(),
  }
}

/**
 * `createReadStream` 只被 index.js 的静态托占用，而 App 内前端由 WebView
 * 直接从 assets 加载，**根本不走这个函数**。留一个显式报错，避免误用。
 */
export function createReadStream() {
  throw new Error('fs-shim: 浏览器环境不支持 createReadStream（App 内不经过 HTTP 静态托管）')
}

/** 清空全部虚拟文件（仅调试用） */
export function __reset() {
  for (const key of [...loadAll().keys()]) {
    try { localStorage.removeItem(PREFIX + key) } catch { /* 忽略 */ }
  }
  cache = new Map()
}

const fsShim = {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, renameSync, copyFileSync, statSync, createReadStream, __reset,
}
export default fsShim
