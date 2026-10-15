/**
 * App 独立模式（APK）相关回归测试。
 *
 * 覆盖三块最容易悄悄坏掉的地方：
 *   ① shim 与 Node 行为是否一致（哈希算法一旦算错，作品 ID / 指纹全乱）；
 *   ② 虚拟文件系统（localStorage）能否正确存取、升级后是否还读得到旧数据；
 *   ③ 传输无关的路由层在「本地模式」下是否给出与 HTTP 一致的返回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import nodeCrypto from 'node:crypto'

/* ------------------- 浏览器环境垫片（供 shim 使用） ------------------- */

function installBrowserEnv() {
  const mem = new Map()
  globalThis.localStorage = {
    get length() { return mem.size },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)) },
    removeItem: (k) => { mem.delete(k) },
    clear: () => mem.clear(),
  }
  if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
    globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
  }
  return mem
}

/* ----------------------- ① shim 与 Node 一致性 ----------------------- */

const { createHash: shimHash, randomBytes: shimRandomBytes, timingSafeEqual: shimTimingSafeEqual } =
  await import('../src/backend/shims/crypto.js')

test('crypto shim：SHA-1 / SHA-256 与 Node 逐字节一致', () => {
  const cases = [
    '', 'a', 'abc', 'hello world', '中文测试·墨笔',
    'x'.repeat(1000), '长'.repeat(300), 'entity:季临安', '{"a":1,"b":[2,3]}',
    // 跨过 SHA 的 56 字节填充边界
    'A'.repeat(55), 'A'.repeat(56), 'A'.repeat(57), 'A'.repeat(64), 'A'.repeat(65),
  ]
  for (const s of cases) {
    for (const algo of ['sha1', 'sha256']) {
      const want = nodeCrypto.createHash(algo).update(s).digest('hex')
      const got = shimHash(algo).update(s).digest('hex')
      assert.equal(got, want, `${algo} 对「${s.slice(0, 12)}…」(len=${s.length}) 不一致`)
    }
  }
})

test('crypto shim：多次 update 与一次性 update 等价', () => {
  const parts = ['前半段', '·中间·', '后半段']
  const oneShot = nodeCrypto.createHash('sha256').update(parts.join('')).digest('hex')
  const h = shimHash('sha256')
  for (const p of parts) h.update(p)
  assert.equal(h.digest('hex'), oneShot)
})

test('crypto shim：randomBytes 长度正确且不重复', () => {
  const a = shimRandomBytes(12)
  const b = shimRandomBytes(12)
  assert.equal(a.length, 12)
  assert.equal(b.length, 12)
  assert.notEqual(a.toString('hex'), b.toString('hex'))
  assert.match(a.toString('hex'), /^[0-9a-f]{24}$/)
})

test('crypto shim：timingSafeEqual 语义与 Node 一致', () => {
  const eq = (x, y) => shimTimingSafeEqual(Buffer.from(x), Buffer.from(y))
  assert.equal(eq('abc', 'abc'), true)
  assert.equal(eq('abc', 'abd'), false)
  assert.equal(eq('abc', 'abcd'), false) // 长度不同必须为 false，不能抛错
})

/* --------------------- ② 虚拟文件系统与路径稳定性 --------------------- */

test('fs shim：写入后能读出，且落盘到 localStorage', () => {
  const mem = installBrowserEnv()
  return import('../src/backend/shims/fs.js').then(({ default: fs, __reset }) => {
    __reset()
    fs.writeFileSync('/mobi-app/data/a.json', '{"x":1}')
    assert.equal(fs.readFileSync('/mobi-app/data/a.json', 'utf8'), '{"x":1}')
    assert.equal(fs.existsSync('/mobi-app/data/a.json'), true)
    assert.equal(fs.existsSync('/mobi-app/data/none.json'), false)
    // 真的写进了 localStorage（而不是只在内存里）
    assert.equal(mem.get('mobi_fs::/mobi-app/data/a.json'), '{"x":1}')
  })
})

test('fs shim：readdir / unlink / rename / copy 基本语义', async () => {
  installBrowserEnv()
  const { default: fs, __reset } = await import('../src/backend/shims/fs.js')
  __reset()
  fs.writeFileSync('/d/p1.json', '1')
  fs.writeFileSync('/d/p2.json', '2')
  fs.mkdirSync('/d/sub', { recursive: true })
  fs.writeFileSync('/d/sub/p3.json', '3')

  assert.deepEqual(fs.readdirSync('/d').sort(), ['p1.json', 'p2.json', 'sub'])

  fs.renameSync('/d/p1.json', '/d/p9.json')
  assert.equal(fs.existsSync('/d/p1.json'), false)
  assert.equal(fs.readFileSync('/d/p9.json', 'utf8'), '1')

  fs.copyFileSync('/d/p2.json', '/d/p2copy.json')
  assert.equal(fs.readFileSync('/d/p2copy.json', 'utf8'), '2')

  fs.unlinkSync('/d/p9.json')
  assert.equal(fs.existsSync('/d/p9.json'), false)
  // 删除不存在的文件必须抛错（静默成功会让「作品凭空消失」难以排查）
  assert.throws(() => fs.unlinkSync('/d/none.json'), /ENOENT/)
})

test('url shim：虚拟根恒定，不随构建产物 hash 变化（升级不丢数据）', async () => {
  const { fileURLToPath, VIRTUAL_ROOT } = await import('../src/backend/shims/url.js')
  const a = fileURLToPath('https://localhost/assets/index-AAA111.js')
  const b = fileURLToPath('https://localhost/assets/index-ZZZ999.js')
  // 关键：两次「不同构建」必须得到同一个稳定路径前缀
  assert.equal(a.split('/').slice(0, -1).join('/'), b.split('/').slice(0, -1).join('/'))
  assert.ok(a.includes(VIRTUAL_ROOT), `路径应含稳定虚拟根 ${VIRTUAL_ROOT}`)
  // ROOT 由 dirname(...)+'..' 求得，必须恰好落在 VIRTUAL_ROOT 上
  const path = (await import('../src/backend/shims/path.js')).default
  assert.equal(path.resolve(path.dirname(a), '..'), VIRTUAL_ROOT)
})

/* ------------------------- ③ 传输无关路由层 ------------------------- */

test('api-router：本地调用与 HTTP 语义一致（健康检查 / 404 / 参数校验）', async () => {
  installBrowserEnv()
  const { createApiRouter } = await import('../server/api-router.js')
  const patchedStore = await import('../server/store.js')

  const router = createApiRouter({
    store: patchedStore,
    pipeline: {},
    workflow: {},
    replanner: {},
    assistant: {},
    changes: {},
    testConnection: async () => ({ ok: true, mode: 'stub' }),
    validateChapterCount: (n) => Number(n) || 30,
    normalizeGenreTags: (t) => (Array.isArray(t) ? t : []),
  })

  const health = await router({ path: '/api/health', method: 'GET' })
  assert.equal(health.status, 200)
  assert.equal(health.data.ok, true)
  assert.equal(typeof health.data.hasKey, 'boolean')

  const missing = await router({ path: '/api/nope', method: 'GET' })
  assert.equal(missing.status, 404)
  assert.match(missing.data.error, /接口不存在/)

  const noIdea = await router({ path: '/api/projects', method: 'POST', body: { idea: '   ' } })
  assert.equal(noIdea.status, 400)
  assert.match(noIdea.data.error, /灵感/)
})

test('api-router：公开配置绝不含明文密钥', async () => {
  installBrowserEnv()
  const store = await import('../server/store.js')
  store.saveConfig({ apiKey: 'sk-secret-abcdef123456' })
  const pub = store.publicConfig()
  assert.equal('apiKey' in pub, false, 'publicConfig 不得携带 apiKey 字段')
  assert.equal(pub.hasKey, true)
  assert.equal(pub.keyTail, '3456')
})

/**
 * 防「测试冲掉真实密钥」事故复发。
 *
 * 背景：上面那条测试会真的调 `store.saveConfig()` 写磁盘。修复前它写的是
 * **真实** `mobi/data/config.json`，而 `saveConfig` 是「读现有 → 合并 → 写回」
 * ⇒ 主人真实的 DeepSeek 密钥被覆盖成 `sk-secret-abcdef123456`，
 * 表现为所有模型调用突然 401（还被 DeepSeek 的「密钥可能已泄露」文案误导过）。
 *
 * 这条测试不依赖任何调用方自觉，直接断言**数据目录已被隔离到临时区**：
 * 只要 `MOBI_DATA_DIR` 没生效，下面的断言立刻失败，事故无法重现。
 */
test('【必测】测试必须写进临时数据目录，绝不能碰真实 data/ 里的密钥', async () => {
  const path = (await import('node:path')).default
  const { ROOT } = await import('../server/store.js')

  const dataDir = process.env.MOBI_DATA_DIR
  assert.ok(dataDir, 'MOBI_DATA_DIR 必须被设置（由 tests/_isolate.mjs 注入）；否则测试会写进真实数据目录')

  const realData = path.join(ROOT, 'data')
  assert.notEqual(
    path.resolve(dataDir),
    path.resolve(realData),
    '数据目录被解析成了真实的 <项目>/data —— 测试会把主人的密钥冲掉'
  )

  // 再确认一次：临时数据目录确实在系统临时区，而不是项目里
  const os = await import('node:os')
  assert.ok(
    path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())) || !path.resolve(dataDir).startsWith(path.resolve(ROOT)),
    `数据目录应位于项目之外（当前为 ${dataDir}）`
  )

  // 真实配置文件此刻的密钥，与测试写入的占位符不是同一个
  const fs = await import('node:fs')
  const realConfig = path.join(realData, 'config.json')
  if (fs.existsSync(realConfig)) {
    const key = JSON.parse(fs.readFileSync(realConfig, 'utf8')).apiKey
    assert.notEqual(
      key,
      'sk-secret-abcdef123456',
      '真实 config.json 里躺着测试占位符 —— 主人的密钥已经被冲掉了！'
    )
  }
})

/* --------------------------- ④ 前端门面判定 --------------------------- */

test('前端 api：LOCAL_MODE 由构建变量决定，且不影响非本地分支', async () => {
  // 直接读源码断言契约，避免引入 React 运行时
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = (await import('node:path')).default
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'api.js'),
    'utf8'
  )
  assert.match(src, /VITE_MOBI_LOCAL/, 'local 模式必须由 VITE_MOBI_LOCAL 决定')
  assert.match(src, /LOCAL_MODE/, '必须导出 LOCAL_MODE 供页面判断')
  assert.match(src, /import\('\.\.\/backend\/app\.js'\)/, '本地后端应懒加载，避免拖慢网页版首屏')
})
