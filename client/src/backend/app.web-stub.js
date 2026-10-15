/**
 * 网页版（桌面 / 局域网）专用的**后端占位模块**。
 *
 * 背景：`src/lib/api.js` 里有一句 `import('../backend/app.js')` 用来加载 App 内
 * 的本地后端。这句在「网页版」永远不会执行（网页版走 fetch('/api')），
 * 但它是个**动态 import**，Rollup 无法静态判定，于是网页版产物里也会多出一个
 * 120KB+ 的后端 chunk（含 fs/crypto shim）。
 *
 * ⇒ vite.config.js 在**非 app 模式**下把 `src/backend/app.js` 指到本文件，
 *   网页版就完全不含后端代码。App 构建（--mode app）不受影响，走真实实现。
 *
 * 若这里被真的调用到了（说明构建模式判定出了问题），**显式抛错**而不是静默返回 ——
 * 静默失败会让「网页版莫名连不上后端」极难排查。
 */

const WRONG_MODE = '这是网页版构建产物，不含本地后端。请用电脑启动的墨笔服务访问，'
  + '或改用 npm run build:app 构建 App 版。'

export function call() {
  throw new Error(WRONG_MODE)
}

export function resumePendingRuns() {
  return 0
}

export const store = {}
export const pipeline = {}
