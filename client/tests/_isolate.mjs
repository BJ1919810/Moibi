/**
 * 测试隔离前置模块（由 `node --test --import ./tests/_isolate.mjs` 加载）。
 *
 * 为什么必须有这个文件：
 *   `server/store.js` 的 `getConfig/saveConfig` 读写的是**真实**数据目录里的
 *   `data/config.json`（含主人真实的 DeepSeek 密钥）。而 `tests/backend-shim.test.js`
 *   为了验证 `publicConfig()` 不泄露明文，会调 `store.saveConfig({apiKey:'sk-secret-…'})`。
 *   由于 `saveConfig` 是「读现有 → 合并 → 写回」，它会**把真实密钥整条覆盖成测试占位符**。
 *
 *   真实踩坑（v2.0.0 期间，排查了很久）：跑完测试后所有模型调用突然 401，
 *   而 DeepSeek 的报错文案正好是「我们可能会自动禁用我们发现已公开泄露的 API key」
 *   ⇒ 极易误判成「密钥泄露被官方封禁」，实际是**测试把自己的密钥冲掉了**。
 *
 * 对策：**在 import server/store.js 之前**把 `MOBI_DATA_DIR` 指向每个测试进程
 *      专属的临时目录。Node 的测试运行器会为每个测试文件 fork 一个子进程，
 *      并继承 `--import`，因此每个文件各拿到一份干净且互不干扰的数据目录。
 *
 * ⚠️ 顺序至关重要：本模块必须**先于**任何 `import '../server/store.js'` 执行。
 *    `--import` 语义正好保证这一点（在任何测试模块被加载前完成）。
 *    若已设置 `MOBI_DATA_DIR`（例如手工指向某目录），则尊重外部设置，不覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.env.MOBI_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobi-test-data-'))
  process.env.MOBI_DATA_DIR = dir
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 进程退出时清理失败无所谓，临时目录会由系统回收 */
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
}
