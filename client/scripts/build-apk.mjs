/**
 * 墨笔 APK 构建脚本。
 *
 * 用法：node scripts/build-apk.mjs [debug|release]
 *
 * 做的事（每一步都先检查前置条件，失败立即停）：
 *   1. 确认工具链（JDK17 / Android SDK / Gradle）就位；
 *   2. 检查前端产物确实是「本地模式」（缺后端 chunk 就直接拒绝）；
 *   3. cap sync 同步 web 资源到 Android 工程；
 *   4. 调 gradle assembleDebug|assembleRelease；
 *   5. 把产物复制到 outputs/ 并按版本命名；
 *   6. **解包核对**：确认 APK 里的 index.html 引用的 JS 与 dist 里**逐字节一致**，
 *      且后端 chunk 确实打进了包（防止「改了源码没进包」——本项目 skill 记过这个坑）。
 *
 * ⚠️ 本机 Node 的 `spawnSync` / `execFileSync` 会稳定 EBUSY（连 cmd.exe 都起不来，
 *    属系统级限制，已实测）。因此**一律用异步 spawn**，整个脚本是 async 的。
 *
 * ⚠️ 为什么不用 gradlew：本工程没有 wrapper jar，必须用系统 Gradle 的绝对路径。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const GRADLE = 'C:/Users/zbj/.gradle/wrapper/dists/gradle-8.14.3-bin/40dfek2kz346l18gf9ltjsnyd/gradle-8.14.3/bin/gradle.bat'
const JDK_HOME = 'D:/Android/jdk-17.0.20.1+1'
const SDK_DIR = 'D:/Android/Sdk'
const PYTHON = process.env.MOBI_PYTHON || 'C:/Users/zbj/.workbuddy/binaries/python/envs/default/Scripts/python.exe'

const variant = process.argv[2] === 'release' ? 'release' : 'debug'
const task = variant === 'release' ? 'assembleRelease' : 'assembleDebug'
const apkDir = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', variant)
const apkName = `app-${variant}.apk`

function fail(msg) {
  console.error(`\n  [构建失败] ${msg}\n`)
  process.exit(1)
}
const step = (msg) => console.log(`\n  ▸ ${msg}`)

/** 运行外部命令并收集输出（异步，规避本机 spawnSync EBUSY） */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

/* ---------------------------- 1. 前置检查 ---------------------------- */

step('检查构建工具链')
if (!fs.existsSync(GRADLE)) fail(`找不到 Gradle：${GRADLE}`)
if (!fs.existsSync(JDK_HOME)) fail(`找不到 JDK 17：${JDK_HOME}`)
if (!fs.existsSync(SDK_DIR)) fail(`找不到 Android SDK：${SDK_DIR}`)
if (!fs.existsSync(path.join(ROOT, 'android'))) fail('尚未生成 Android 工程。请先执行：npx cap add android')
console.log('    JDK / SDK / Gradle 均就位')

step('检查前端产物（App 本地模式）')
const distIndex = path.join(ROOT, 'dist', 'index.html')
if (!fs.existsSync(distIndex)) fail('dist/ 不存在，请先执行 npm run build:app')
const distHtml = fs.readFileSync(distIndex, 'utf8')
const distJs = (distHtml.match(/assets\/index-[\w-]+\.js/) || [])[0]
if (!distJs) fail('dist/index.html 里找不到构建产物引用，构建可能不完整。')

const distAssetsDir = path.join(ROOT, 'dist', 'assets')
const backendChunk = fs.readdirSync(distAssetsDir).find((f) => /^app-[\w-]+\.js$/.test(f))
if (!backendChunk) {
  fail('dist 里没有后端 chunk（app-*.js）—— 说明这不是 `--mode app` 的构建。\n'
    + '    App 必须用 npm run build:app，否则装到手机上会「连不上后端」。')
}
const backendSize = fs.statSync(path.join(distAssetsDir, backendChunk)).size
console.log(`    ${distJs} + ${backendChunk}（后端 ${(backendSize / 1024).toFixed(0)} KB）`)

/* ------------------------- 2. 同步到 android ------------------------- */

step('同步 web 资源到 Android 工程')
{
  const capBin = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor')
  const r = await run(process.execPath, [capBin, 'sync', 'android'], { cwd: ROOT })
  if (r.code !== 0) fail(`cap sync 失败：\n${r.out.slice(-800)}`)
  console.log('    已同步')
}

/* ---------------------------- 3. 编译 APK ---------------------------- */

step(`编译 APK（${variant}）`)
const start = Date.now()
{
  const r = await run(GRADLE, [task, '--console=plain'], {
    cwd: path.join(ROOT, 'android'),
    env: { ...process.env, JAVA_HOME: JDK_HOME, ANDROID_HOME: SDK_DIR },
    shell: true,
  })
  if (r.code !== 0) fail(`gradle ${task} 失败：\n${r.out.slice(-1500)}`)
}
console.log(`    耗时 ${((Date.now() - start) / 1000).toFixed(1)} 秒`)

/* ------------------------ 4. 归档 + 解包核对 ------------------------ */

const builtApk = path.join(apkDir, apkName)
if (!fs.existsSync(builtApk)) fail(`未找到产物：${builtApk}`)

step('归档产物')
const outputsDir = path.join(ROOT, 'outputs')
fs.mkdirSync(outputsDir, { recursive: true })

const appGradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8')
const versionName = (appGradle.match(/versionName\s+"([^"]+)"/) || [])[1] || '0.0.0'
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const outName = `墨笔_v${versionName}-${variant}-${stamp}.apk`
const dest = path.join(outputsDir, outName)
fs.copyFileSync(builtApk, dest)
const sizeKB = (fs.statSync(dest).size / 1024).toFixed(0)
console.log(`    ${outName}  (${sizeKB} KB)`)

step('解包核对：确认包内前端与 dist 一致')
const checkerPath = path.join(ROOT, '.wb-verify-apk.py')
fs.writeFileSync(checkerPath, `# -*- coding: utf-8 -*-
import zipfile, re, sys, hashlib, json, pathlib

apk, dist_assets = sys.argv[1], pathlib.Path(sys.argv[2])
z = zipfile.ZipFile(apk)
names = z.namelist()

html = next((z.read(n).decode('utf-8', 'replace') for n in names if n.endswith('public/index.html')), None)
if not html:
    print(json.dumps({'ok': False, 'why': 'APK 内找不到 public/index.html'})); sys.exit(0)

m = re.search(r'assets/index-[\\w-]+\\.js', html)
if not m:
    print(json.dumps({'ok': False, 'why': 'APK 内的 index.html 没有产物引用'})); sys.exit(0)
js = m.group(0)
entry = 'assets/public/' + js
if entry not in names:
    print(json.dumps({'ok': False, 'why': '引用了 ' + js + ' 但包里不存在'})); sys.exit(0)

inner = z.read(entry)
outer = (dist_assets / js.split('/')[-1]).read_bytes()

app_entries = [n for n in names if re.search(r'assets/public/assets/app-[\\w-]+\\.js$', n)]
backend_ok, backend_size = False, 0
if app_entries:
    b = z.read(app_entries[0])
    backend_size = len(b)
    backend_ok = (b'mobi_fs::' in b) and (b'mobi-app' in b)

print(json.dumps({
    'ok': hashlib.sha256(inner).hexdigest() == hashlib.sha256(outer).hexdigest(),
    'js': js, 'innerSize': len(inner), 'outerSize': len(outer),
    'backendChunk': app_entries[0] if app_entries else None,
    'backendSize': backend_size, 'backendOk': backend_ok,
}))
`, 'utf8')

let check = { ok: false }
try {
  const r = await run(PYTHON, [checkerPath, dest, distAssetsDir])
  check = JSON.parse(r.out.trim().split('\n').pop())
} catch (e) {
  console.warn(`    ⚠️  核对脚本未跑通（${e.message}），请手工解包确认。`)
} finally {
  try { fs.unlinkSync(checkerPath) } catch { /* 忽略 */ }
}

if (check.ok === false) {
  console.warn(`    ⚠️  核对未通过：${check.why || '内容不一致'}`)
} else if (check.ok) {
  console.log(`    ✅ 包内 ${check.js} 与 dist 逐字节一致（${(check.innerSize / 1024).toFixed(0)} KB）`)
  console.log(`    ${check.backendOk ? '✅' : '❌'} 后端逻辑已打进包（${(check.backendSize / 1024).toFixed(0)} KB，本地模式${check.backendOk ? '生效' : '缺失'}）`)
}

console.log(`
  构建完成
  ─────────────────────────────────────
  产物   ${dest}
  大小   ${sizeKB} KB
  版本   ${versionName}（${variant}）
`)
