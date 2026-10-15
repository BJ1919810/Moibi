/**
 * `node:path` 的浏览器替代实现（POSIX 语义）。
 *
 * 后端只用它来计算**虚拟文件系统里的内部路径**（store.js 的 data/ 目录结构），
 * 不涉及真实磁盘。因此统一按 POSIX 规则处理，`\` 不做分隔符。
 * 覆盖的方法：join / resolve / dirname / basename / extname / sep。
 */

export const sep = '/'

function normalize(p) {
  if (!p) return '.'
  const abs = p.startsWith('/')
  const parts = String(p).split('/')
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // 已在根目录时，`..` 直接丢弃（不会越出虚拟根）
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(part)
  }
  const body = out.join('/')
  if (abs) return '/' + body
  return body || '.'
}

export function resolve(...args) {
  let resolved = ''
  for (let i = args.length - 1; i >= 0; i--) {
    const p = String(args[i] ?? '')
    if (!p) continue
    resolved = resolved ? `${p}/${resolved}` : p
    if (p.startsWith('/')) break
  }
  // 全是相对路径时，以虚拟根为基准（浏览器里没有真实 cwd）
  if (!resolved.startsWith('/')) resolved = `/${resolved}`
  return normalize(resolved)
}

export function join(...args) {
  const parts = args.filter((p) => p !== undefined && p !== null && p !== '').map(String)
  if (!parts.length) return '.'
  return normalize(parts.join('/'))
}

export function dirname(p) {
  const s = normalize(String(p))
  if (s === '/' || s === '.') return s === '/' ? '/' : '.'
  const idx = s.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return s.slice(0, idx)
}

export function basename(p, ext) {
  const s = String(p).replace(/\/+$/, '')
  const idx = s.lastIndexOf('/')
  let base = idx >= 0 ? s.slice(idx + 1) : s
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length)
  return base
}

export function extname(p) {
  const base = basename(p)
  const idx = base.lastIndexOf('.')
  if (idx <= 0) return ''
  return base.slice(idx)
}

const pathShim = { sep, resolve, join, dirname, basename, extname, normalize }
export default pathShim
