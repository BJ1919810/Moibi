/**
 * `node:os` 的浏览器替代实现。
 *
 * 后端只在 index.js 的启动打印里用它枚举局域网地址，用来把「手机访问地址」
 * 打到控制台。**App 内根本没有控制台、也不经过 HTTP**，所以这里只需给出
 * 一个不会崩的最小实现即可。
 */

export function networkInterfaces() {
  return {}
}

export function platform() {
  return 'android'
}

export function hostname() {
  return 'localhost'
}

export function cpus() {
  return []
}

const osShim = { networkInterfaces, platform, hostname, cpus }
export default osShim
