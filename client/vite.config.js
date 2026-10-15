import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 把后端用到的 `node:*` 内置模块重定向到浏览器可用实现。
 *
 * 背景：墨笔有两种形态 ——
 *   ① 桌面服务：后端跑在 Node 里，走真实 node: 模块（本别名不影响它）；
 *   ② App 内独立：后端逻辑编进前端 bundle，必须在浏览器里跑。
 * 只有 ② 需要这些 shim。shim 与 Node 行为**逐字节一致**（tests/backend-shim.test.js 比对哈希）。
 *
 * 注意：别名只在打包解析阶段生效，`server/` 源码本身一个字都不改 ——
 * 这样「同一份代码既能在 Node 跑、也能在浏览器跑」。
 */
const NODE_SHIM = {
  'node:crypto': 'src/backend/shims/crypto.js',
  'node:fs': 'src/backend/shims/fs.js',
  'node:path': 'src/backend/shims/path.js',
  'node:os': 'src/backend/shims/os.js',
  'node:url': 'src/backend/shims/url.js',
}

const nodeShimAlias = {
  name: 'mobi-node-shim-alias',
  enforce: 'pre',
  resolveId(source) {
    const target = NODE_SHIM[source]
    if (target) return path.resolve(__dirname, target)
    if (source.startsWith('node:')) {
      // 未映射的 node 内置模块：显式报错，避免打成外部依赖后运行时才炸
      throw new Error(
        `[vite] 未映射的 Node 内置模块「${source}」。请在 vite.config.js 的 NODE_SHIM 里补上对应 shim，`
          + '或确认该模块不该出现在前端 bundle 里。'
      )
    }
    return null
  },
}

export default defineConfig(({ mode }) => {
  // App 构建（--mode app）才把后端编进来；网页版用占位模块，
  // 否则那句动态 import 会让网页版也背上 120KB+ 的后端 chunk。
  const isApp = mode === 'app'

  return {
    plugins: [nodeShimAlias, react()],
    resolve: {
      alias: [
        // ⚠️ 必须放在最前：否则会被下面的 node:* 别名与默认解析抢走
        ...(isApp
          ? []
          : [{ find: /^.*\/backend\/app\.js$/, replacement: path.resolve(__dirname, 'src/backend/app.web-stub.js') }]),
        { find: /^node:crypto$/, replacement: path.resolve(__dirname, 'src/backend/shims/crypto.js') },
        { find: /^node:fs$/, replacement: path.resolve(__dirname, 'src/backend/shims/fs.js') },
        { find: /^node:path$/, replacement: path.resolve(__dirname, 'src/backend/shims/path.js') },
        { find: /^node:os$/, replacement: path.resolve(__dirname, 'src/backend/shims/os.js') },
        { find: /^node:url$/, replacement: path.resolve(__dirname, 'src/backend/shims/url.js') },
      ],
    },
    base: './',
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:8787',
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2020',
    },
  }
})
