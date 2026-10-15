/**
 * 判定「当前是否跑在 Android 原生壳（APK）里」。
 *
 * 为什么要单独抽出来：
 *   `@capacitor/core` 的 `Capacitor.isNativePlatform()` 是官方 API，但它需要
 *   **静态 import 整个 core**；而墨笔的网页版（桌面/局域网）不该为它白背体积。
 *   所以这里用「等价判据」写在业务侧，让 core 只在需要时被动态 import。
 *
 * ⚠️ 判据必须包含 `window.androidBridge`，这是**关键**：
 *   Capacitor 内部判定平台就是看 `win.androidBridge`（见 core 的 getPlatformId）。
 *   它是 WebView `addJavascriptInterface` 注入的原生对象，**在页面任何脚本执行前
 *   就已存在**，时序上最早、最可靠。
 *
 *   只靠 `window.Capacitor` 会有**时序漏洞**：App.jsx 在模块顶层就求这个值，
 *   而 `@capacitor/core` 往往要等到后续 `import('@capacitor/app')` 时才初始化
 *   `window.Capacitor`。判早了 ⇒ 误判成网页版 ⇒ 返回键监听器压根不注册
 *   ⇒ 在手机上按返回键直接退出应用。
 */
export function isNativeShell(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return false
  // ① 原生桥对象：Android WebView 注入，最早存在，网页版绝不会有
  if (win.androidBridge) return true
  // ② core 已初始化时，直接用官方判据
  if (win.Capacitor?.isNativePlatform?.() === true) return true
  // ③ 兼容 core 把 platform 固化成字符串的情形
  if (win.Capacitor?.platform === 'android') return true
  return false
}
