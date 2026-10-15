import test from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorized, checkToken, normalizeIp, isLocalIp } from '../server/auth.js'

const EXPECTED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const EXTERNAL = '192.168.1.50'

/* --------------------------- 本机免检 --------------------------- */

test('本机地址免检（含 IPv4-mapped IPv6 写法）', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(
      isAuthorized({ remoteAddress: ip, expected: EXPECTED }),
      true,
      `${ip} 应免检`
    )
  }
})

/* --------------------------- 外部地址拒绝 --------------------------- */

test('外部地址未携带口令 → 拒绝', () => {
  const cases = [
    { remoteAddress: EXTERNAL },
    { remoteAddress: EXTERNAL, headerToken: '' },
    { remoteAddress: EXTERNAL, queryToken: null },
  ]
  for (const c of cases) {
    assert.equal(isAuthorized({ ...c, expected: EXPECTED }), false, JSON.stringify(c))
  }
})

test('外部地址携带错误口令 → 拒绝', () => {
  const wrongs = ['wrong', EXPECTED + 'x', EXPECTED.slice(0, -1), 'A1B2C3D4E5F60718293A4B5C6D7E8F90']
  for (const w of wrongs) {
    assert.equal(
      isAuthorized({ remoteAddress: EXTERNAL, headerToken: w, expected: EXPECTED }),
      false,
      `口令 ${w} 应被拒绝`
    )
  }
})

test('外部地址携带正确口令 → 放行', () => {
  assert.equal(
    isAuthorized({ remoteAddress: EXTERNAL, headerToken: EXPECTED, expected: EXPECTED }),
    true
  )
  // 查询参数通道（供 <a> 直接下载使用）
  assert.equal(
    isAuthorized({ remoteAddress: EXTERNAL, queryToken: EXPECTED, expected: EXPECTED }),
    true
  )
})

test('口令为空字符串时不得放行', () => {
  assert.equal(isAuthorized({ remoteAddress: EXTERNAL, headerToken: '', queryToken: '', expected: '' }), false)
})

/* --------------------------- 辅助函数 --------------------------- */

test('normalizeIp 归一 IPv4-mapped IPv6', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5')
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp(undefined), '')
})

test('isLocalIp 只认回环地址', () => {
  assert.equal(isLocalIp('127.0.0.1'), true)
  assert.equal(isLocalIp('::1'), true)
  assert.equal(isLocalIp('192.168.1.50'), false)
  assert.equal(isLocalIp('10.0.0.1'), false)
})

test('checkToken 长度不同不抛异常', () => {
  assert.equal(checkToken('a', 'abcdefghij'), false)
  assert.equal(checkToken('abcdefghij', 'abcdefghij'), true)
})
