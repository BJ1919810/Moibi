import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { isNativeShell } from './lib/native-shell.js'
import './styles/tokens.css'
import './styles/app.css'

// 不使用 StrictMode：其开发期双调用会让「生成一章」这类昂贵请求重复触发
createRoot(document.getElementById('root')).render(<App />)

/**
 * Service Worker 只在「桌面/局域网网页」形态注册。
 *
 * App 内不注册：Capacitor 的 WebView 已经从本地 assets 加载资源，再叠一层 SW
 * 只会让「升级 APK 后页面还是旧的」这类问题更难排查（SW 缓存不随 APK 更新）。
 * 判据见 lib/native-shell.js（含关键的 `window.androidBridge`）。
 */
if (!isNativeShell() && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}))
}
