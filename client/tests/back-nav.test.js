/**
 * 返回键决策的回归测试。
 *
 * 存在意义：曾经出过一个「只在浏览器里看着对」的假 bug ——
 * App.jsx 挂了 popstate 监听器，浏览器里测返回键一切正常，
 * 但装成 APK 后 Capacitor 核心根本不接管返回键（onBackPressed 命中数 0），
 * 系统直接 finish() Activity，按一下**直接退出应用**，popstate 从不触发。
 *
 * 所以这里把决策抽成纯函数（src/lib/back-nav.js）并直接单测，
 * 保证「浮层 → 页面栈 → 交还系统」这套优先级在任何形态下都成立。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveBack,
  backFallback,
  resolveReaderPanel,
  OVERLAY_ORDER,
  OPENABLE_OVERLAYS,
  BACK_PANEL,
  BACK_NAVIGATED,
  BACK_EXIT,
  BACK_INCONSISTENT,
} from '../src/lib/back-nav.js'

/* ---------------------- 优先级：浮层 → 页面栈 → 系统 ---------------------- */

test('浮层开着时，返回键只关浮层，不动页面栈', () => {
  const r = resolveBack({ overlays: { nav: true }, view: 'outline', stack: ['shelf', 'outline'] })
  assert.equal(r, BACK_PANEL)
})

test('多个浮层同开属于状态矛盾：不猜、也不退页面，交给 backFallback', () => {
  // 浮层现在是「铺平」的，所以同时为真只可能是状态坏了 ——
  // 决策必须停下来兜底，绝不能猜一个去关（猜错会关掉用户没指定的那一层）。
  const r = resolveBack({
    overlays: { export: true, nav: true },
    view: 'outline',
    stack: ['shelf', 'outline'],
  })
  assert.equal(r, BACK_INCONSISTENT)
  assert.equal(backFallback(), BACK_PANEL, '兜底只关浮层，不丢页面、不退出应用')
})

/* ------------------- 「AI 助手 / 创作资料」是页面，不是浮层 ------------------- */

test('AI 助手与创作资料改成整页后，返回键靠页面栈退，不需要登记浮层', () => {
  // 改造前它们走 overlays；现在走 stack ⇒ 从这一页按返回只退一层、不退出应用。
  for (const v of ['assistant', 'materials']) {
    assert.equal(
      resolveBack({ overlays: {}, view: v, stack: ['shelf', 'outline', v] }),
      BACK_NAVIGATED,
      `${v} 在页面栈里 ⇒ 应退回上一层`,
    )
  }
})

test('浮层集合只剩「导出 + 作品导航」', () => {
  assert.deepEqual([...OPENABLE_OVERLAYS].sort(), ['export', 'nav'])
})

test('单个浮层（导出）开着 ⇒ 只关它，页面不动', () => {
  const r = resolveBack({ overlays: { export: true }, view: 'outline', stack: ['shelf', 'outline'] })
  assert.equal(r, BACK_PANEL)
})

test('无浮层且栈深 > 1：退回上一层', () => {
  assert.equal(resolveBack({ overlays: {}, view: 'write', stack: ['shelf', 'outline', 'write'] }), BACK_NAVIGATED)
  assert.equal(resolveBack({ overlays: {}, view: 'outline', stack: ['shelf', 'outline'] }), BACK_NAVIGATED)
})

test('栈深 = 1（书架）：交还系统 —— App 里等于允许退出', () => {
  assert.equal(resolveBack({ overlays: {}, view: 'shelf', stack: ['shelf'] }), BACK_EXIT)
})

test('stack 用数组传（App.jsx 的真实调用方式）', () => {
  assert.equal(resolveBack({ view: 'write', stack: ['shelf', 'outline', 'write'] }), BACK_NAVIGATED)
  assert.equal(resolveBack({ view: 'shelf', stack: ['shelf'] }), BACK_EXIT)
})

test('stackDepth 仍接受数字（兼容老签名）', () => {
  assert.equal(resolveBack({ view: 'write', stackDepth: 3 }), BACK_NAVIGATED)
  assert.equal(resolveBack({ view: 'shelf', stackDepth: 1 }), BACK_EXIT)
})

test('浮层优先级高于页面栈：书架层开着浮层也不退出应用', () => {
  const r = resolveBack({ overlays: { nav: true }, view: 'shelf', stack: ['shelf'] })
  assert.equal(r, BACK_PANEL, '书架层但导航抽屉开着 ⇒ 先关抽屉，绝不 exitApp')
})

test('缺省参数进得去、不抛错（防御性）', () => {
  assert.equal(resolveBack(), BACK_EXIT)
  assert.equal(resolveBack({}), BACK_EXIT)
})

/* ---------------------- 阅读页内部的第二级面板 ---------------------- */

test('阅读页：设置/目录面板算「已消费」，返回键不退出阅读', () => {
  assert.equal(resolveReaderPanel({ showSettings: true }), true)
  assert.equal(resolveReaderPanel({ showToc: true }), true)
  assert.equal(resolveReaderPanel({ showSettings: false, showToc: false }), false)
  assert.equal(resolveReaderPanel(), false)
})

/* ---------------------- 回归锚点 ---------------------- */

test('OVERLAY_ORDER 覆盖 OPENABLE_OVERLAYS（漏一个就会导致该浮层拦不住返回键）', () => {
  for (const name of OPENABLE_OVERLAYS) {
    assert.ok(OVERLAY_ORDER.includes(name), `${name} 没登记进关闭顺序`)
  }
  // 只剩导航这一个可开关的浮层必须被登记
  assert.ok(OVERLAY_ORDER.includes('nav'))
})
