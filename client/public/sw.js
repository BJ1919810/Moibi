/**
 * 墨笔 PWA 基础缓存。只缓存静态界面资源；
 * /api 绝不缓存，避免作品、模型密钥和任务状态过期或泄露。
 * 离线缓存也不是写作任务队列；离线不发起模型请求。
 */
const CACHE = 'mobi-static-v2-reader2-20261012'
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./', './manifest.webmanifest','./icon-192.png'])))
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('mobi-static-') && k !== CACHE).map((k)=>caches.delete(k)))))
  self.clients.claim()
})
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).pathname.startsWith('/api/')) return
  event.respondWith(fetch(req).then((res) => {
    if (res.ok && new URL(req.url).origin === self.location.origin) {
      const clone = res.clone()
      event.waitUntil(caches.open(CACHE).then((cache)=>cache.put(req, clone)))
    }
    return res
  }).catch(()=>caches.match(req)))
})
