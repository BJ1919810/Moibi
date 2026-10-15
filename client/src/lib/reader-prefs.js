/**
 * 阅读器偏好：纯本地存储，与服务端无关。
 *
 * 为什么放 localStorage 而不是后端：这是「这台设备怎么显示」的问题，
 * 手机和平板理应各存一份，同步到服务端反而会互相打架。
 *
 * 音量键换页说明：浏览器/PWA 的网页**拿不到音量键**（被系统占用，无任何 Web API），
 * 因此该开关只在 App 壳 / WebView 里生效（由壳把音量键事件桥接进来）。
 * 在浏览器里开关仍会保存，但不会有效果 —— 面板上如实标注。
 */

const KEY = 'mobi_reader_prefs'

export const READER_DEFAULTS = {
  fontSize: 17.5,      // px
  lineHeight: 2.0,     // 行高倍数
  paragraphGap: 16,    // 段间距 px
  pageMode: 'scroll',  // scroll | page
  volumeKeys: false,   // 音量键换页（仅 App 壳/WebView）
}

export const FONT_RANGE = { min: 14, max: 26, step: 0.5 }
export const GAP_RANGE = { min: 4, max: 40, step: 2 }
export const LINE_RANGE = { min: 1.4, max: 2.8, step: 0.1 }

export function loadReaderPrefs() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...READER_DEFAULTS }
    const parsed = JSON.parse(raw)
    return { ...READER_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...READER_DEFAULTS }
  }
}

export function saveReaderPrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...READER_DEFAULTS, ...prefs }))
  } catch {
    /* 隐私模式/无 localStorage：忽略，只影响持久化 */
  }
}

/** 把偏好转成阅读容器的内联 CSS 变量，供 app.css 消费 */
export function readerStyle(prefs) {
  const p = { ...READER_DEFAULTS, ...prefs }
  return {
    '--reader-font': `${p.fontSize}px`,
    '--reader-line': String(p.lineHeight),
    '--reader-gap': `${p.paragraphGap}px`,
  }
}

/**
 * 阅读模式下的翻页步长。
 *
 * 「翻页」= 把正文横向分列，一次滚动一屏；没有真实分页引擎，因此用一屏宽做步长。
 * ⚠️ 必须是**整屏宽**：`column-width:100%` 决定每一列正好是一屏，
 *    取 0.92 会停在两列中间，下一次点击看起来像「跳了半屏」。
 */
export function pageStep(el) {
  if (!el) return 0
  return Math.max(1, el.clientWidth)
}
