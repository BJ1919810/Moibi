import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHost, checkOrigin, allowedHostsFromEnv } from '../server/auth.js'

/**
 * DNS rebinding 的防线：**Host 头白名单**。
 *
 * ⛔ 只做 Origin/Host 一致性**挡不住**它：攻击者在自己的 8787 端口托管页面，
 *    页面里的请求对它而言是同源的（GET 连 Origin 都不发），DNS 重新解析到 127.0.0.1 后
 *    `Host: evil.com:8787` 就长驱直入。`checkOrigin` 保留用于挡 CSRF 那一半。
 *
 * 这个测试同时是**「不会误伤真实用法」的清单**（这是我最担心的部分）：
 * 手机走局域网 IP、`http://mybox:8787`、mDNS 的 `x.local` 都必须放行。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

test('放行：本机 / 回环 / 局域网 / 单标签 / mDNS（真实用法一个都不能误伤）', () => {
  const allow = [
    '127.0.0.1', '127.0.0.1:8787', 'localhost', 'localhost:8787', 'LOCALHOST:8787',
    '[::1]:8787', '::1',
    '192.168.1.5:8787', '10.0.0.7', '172.16.3.9', '172.31.255.1',   // 私有段
    'mybox:8787', 'DESKTOP-ABC:8787',                                 // 单标签主机名
    'macbook.local:8787',                                             // mDNS
  ]
  for (const h of allow) assert.equal(checkHost(h).ok, true, `${h} 应当放行`)
})

test('⛔ 拒绝：任何公有 FQDN 与非法地址（DNS rebinding 的签名就是 Host 是公有域名）', () => {
  const deny = ['evil.com', 'evil.com:8787', 'attacker.example.org', '8.8.8.8', 'a.b.c',
    '172.32.0.1',   // 恰好出界（172.16–172.31 才是私有）
    '172.15.0.1', '11.0.0.1', '192.169.1.1', '256.1.1.1.example', '']
  for (const h of deny) assert.equal(checkHost(h).ok, false, `${h} 应当拒绝`)
  assert.equal(checkHost(null).ok, false)
  assert.equal(checkHost(undefined).ok, false)
})

test('显式放行：MOBI_ALLOWED_HOSTS 是留给「有意公开/反代」的出口', () => {
  assert.equal(checkHost('novel.example.com').ok, false, '默认拒绝')
  assert.equal(checkHost('novel.example.com', { extra: ['novel.example.com'] }).ok, true)
  assert.equal(checkHost('NOVEL.example.com:8787', { extra: ['novel.example.com'] }).ok, true, '大小写不敏感')
  assert.deepEqual(allowedHostsFromEnv({ MOBI_ALLOWED_HOSTS: 'Novel.Example.com, foo.bar' }),
    ['novel.example.com', 'foo.bar'])
  assert.deepEqual(allowedHostsFromEnv({}), [])
})

test('CSRF 那一半（checkOrigin）没被削弱', () => {
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' }).ok, true)
  assert.equal(checkOrigin({ origin: 'http://evil.com', host: '127.0.0.1:8787' }).ok, false, '跨源必须拒')
  assert.equal(checkOrigin({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:8787' }).ok, false, '端口不同即跨源')
  assert.equal(checkOrigin({ origin: undefined, host: '127.0.0.1:8787' }).ok, true, 'curl/同源导航不带 Origin ⇒ 放行')
  assert.equal(checkOrigin({ origin: 'null', host: '127.0.0.1:8787' }).ok, false)
})

test('⛔ 接线：HTTP 入口必须**两道都做**（Host 白名单 + Origin 同源）', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  assert.match(text, /checkHost\(req\.headers\.host/, '入口没接 Host 白名单 ⇒ DNS rebinding 仍然可打')
  assert.match(text, /checkOrigin\(\{ origin: req\.headers\.origin/)
  assert.match(text, /MOBI_ALLOWED_HOSTS/, '错误信息里要告诉用户怎么显式放行')
})
