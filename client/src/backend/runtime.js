/**
 * 后端运行时垫片：为浏览器补齐后端代码所依赖的两个全局对象。
 *
 * 后端原本跑在 Node 里，代码里零星用到 `process.pid` / `process.env.*`（6 处）
 * 与 `Buffer`（4 处）。这些在浏览器里不存在，直接跑会 ReferenceError。
 * 本模块在**任何 server/ 模块被求值之前**安装它们（入口处首个 import）。
 *
 * 为什么不用 Vite 的 define 逐个替换：define 只做文本替换，遇到
 * `process.env[k]` 这类动态访问就漏了；而且替换后代码里会留下 `1.tmp` 这种
 * 语义怪异的产物。装一个真对象更稳、也更易读。
 */

if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: {},
    pid: 1,
    platform: 'browser',
    version: 'v20.0.0',
    nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
  }
} else {
  // 已有 process（如 Electron / 某些 WebView）：只补缺失字段
  if (!globalThis.process.env) globalThis.process.env = {}
  if (globalThis.process.pid === undefined) globalThis.process.pid = 1
}

if (typeof globalThis.Buffer === 'undefined') {
  const toBytes = (v) => {
    if (v instanceof Uint8Array) return v
    if (typeof v === 'string') return new TextEncoder().encode(v)
    return new Uint8Array(v || [])
  }
  globalThis.Buffer = {
    from(v) { return toBytes(v) },
    byteLength(v) { return toBytes(v).length },
    concat(list) {
      const arr = list.map(toBytes)
      const total = arr.reduce((n, a) => n + a.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const a of arr) { out.set(a, off); off += a.length }
      return out
    },
    isBuffer() { return false },
  }
}

export const isBackendRuntimeReady = true
