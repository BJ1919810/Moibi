/**
 * `node:url` 的浏览器替代实现（fileURLToPath / pathToFileURL）。
 *
 * ⚠️ 关键设计：**返回固定的虚拟路径，而不是真实 URL 转换结果。**
 *
 * 原因：store.js 用 `path.dirname(fileURLToPath(import.meta.url))` 求模块目录，
 * 再往上推 ROOT，而 ROOT 会拼进虚拟文件系统的路径、进而成为 localStorage 的键。
 * 打包产物里 `import.meta.url` 形如 `https://localhost/assets/index-ABC123.js` ——
 * **每次构建 hash 都会变** ⇒ 键前缀跟着变 ⇒ App 一升级，用户作品全部读不到
 * （表现是「书全没了」，且数据其实还在，极难排查）。
 *
 * ⇒ 统一返回 `${VIRTUAL_ROOT}/server/<文件名>`，让 ROOT 恒为 `/mobi-app`，
 * 与构建产物无关，升级后数据无缝延续。
 */

/** 虚拟文件系统的稳定根目录（不是真实磁盘路径，也不随构建变化） */
export const VIRTUAL_ROOT = '/mobi-app'

/**
 * ⚠️ 必须**恒定**返回 `${VIRTUAL_ROOT}/server/<name>`：
 * store.js 里是 `ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')`，
 * 也就是「再上一层」才是 ROOT。打包后所有模块共用同一个 import.meta.url
 * （即 bundle 文件本身），无法据此判断是否在 server/ 目录下 —— 所以这里
 * 一律当作在 server/ 里，让上一层恰好落在 VIRTUAL_ROOT 上。
 * 若少一层，ROOT 会算成 `/`，数据键变成 `/data/...`，将来改回就丢数据。
 */
export function fileURLToPath(url) {
  let s = String(url || '')
  s = s.split('?')[0].split('#')[0]
  try { s = decodeURIComponent(s) } catch { /* 保持原样 */ }

  // 取最后一段文件名，挂到稳定根下，便于调试时辨认来源
  const name = s.split('/').filter(Boolean).pop() || 'module.js'
  return `${VIRTUAL_ROOT}/server/${name}`
}

export function pathToFileURL(p) {
  return new URL(`file://${VIRTUAL_ROOT}/${String(p).replace(/^[A-Za-z]:[\\/]|\//, '')}`)
}

const urlShim = { fileURLToPath, pathToFileURL, VIRTUAL_ROOT }
export default urlShim
