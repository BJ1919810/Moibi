/**
 * `node:crypto` 的浏览器替代实现（同步版）。
 *
 * 为什么不用 Web Crypto：`crypto.subtle.digest()` 是**异步**的，而墨笔后端里
 * `createHash(...).update(...).digest('hex')` 是**在同步函数里调用**的
 * （schema.js 的 entityId、projection 的指纹、workflow 的 packetHash 等）。
 * 把整条调用链改成异步要动十几个模块，风险远大于收益。
 * ⇒ 这里用纯 JS 实现同步的 SHA-1 / SHA-256，输出与 Node 完全一致。
 *
 * 覆盖的 API（仅后端实际用到的四个）：
 *   createHash(algo).update(data).digest('hex')
 *   randomBytes(n).toString('hex') / .length / 索引访问
 *   timingSafeEqual(a, b)
 */

/* ------------------------------- SHA-256 -------------------------------- */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

function sha256Bytes(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const len = bytes.length
  // 填充：0x80 + 若干 0 + 8 字节大端比特长度，使总长为 64 的倍数
  const withPad = ((len + 8) >> 6) + 1
  const total = withPad * 64
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[len] = 0x80
  const bitLenHi = Math.floor((len * 8) / 0x100000000)
  const bitLenLo = (len * 8) >>> 0
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, bitLenHi)
  dv.setUint32(total - 4, bitLenLo)

  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = b; b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i])
  return out
}

/* -------------------------------- SHA-1 --------------------------------- */

function sha1Bytes(bytes) {
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0])
  const len = bytes.length
  const withPad = ((len + 8) >> 6) + 1
  const total = withPad * 64
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[len] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, Math.floor((len * 8) / 0x100000000))
  dv.setUint32(total - 4, (len * 8) >>> 0)

  const w = new Uint32Array(80)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = ((v << 1) | (v >>> 31)) >>> 0
    }
    let [a, b, c, d, e] = H
    for (let i = 0; i < 80; i++) {
      let f, k
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d; d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a; a = tmp
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
  }
  const out = new Uint8Array(20)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 5; i++) odv.setUint32(i * 4, H[i])
  return out
}

/* ------------------------------ 工具函数 -------------------------------- */

function toBytes(data) {
  if (data == null) return new Uint8Array(0)
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(data)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data && typeof data === 'object' && data.__bytes) return data.__bytes
  return new TextEncoder().encode(String(data))
}

const HEX = '0123456789abcdef'
function bytesToHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  }
  return s
}

/** 极简 Buffer 兼容体：够后端使用（toString('hex') / length / 索引 / byteLength） */
class Bytes extends Uint8Array {
  get __bytes() { return this }
  toString(enc) {
    if (enc === 'hex') return bytesToHex(this)
    if (enc === 'base64') {
      let bin = ''
      for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i])
      return btoa(bin)
    }
    return new TextDecoder().decode(this)
  }
}

function makeBytes(u8) {
  const out = new Bytes(u8.length)
  out.set(u8)
  return out
}

/* ------------------------------- 公开 API ------------------------------- */

const ALGOS = { sha1: sha1Bytes, sha256: sha256Bytes, 'sha-1': sha1Bytes, 'sha-256': sha256Bytes }

export function createHash(algo) {
  const fn = ALGOS[String(algo).toLowerCase()]
  if (!fn) throw new Error(`crypto-shim: 不支持的摘要算法 ${algo}`)
  const chunks = []
  return {
    update(data) { chunks.push(toBytes(data)); return this },
    digest(enc) {
      let total = 0
      for (const c of chunks) total += c.length
      const merged = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { merged.set(c, off); off += c.length }
      const out = fn(merged)
      return enc === 'hex' || enc === undefined ? bytesToHex(out) : makeBytes(out)
    },
  }
}

export function randomBytes(n) {
  const buf = new Uint8Array(Number(n) || 0)
  // 浏览器/WebView 里 getRandomValues 是同步且安全的
  globalThis.crypto.getRandomValues(buf)
  return makeBytes(buf)
}

export function timingSafeEqual(a, b) {
  const x = toBytes(a)
  const y = toBytes(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export function randomUUID() {
  return globalThis.crypto.randomUUID()
}

const cryptoShim = { createHash, randomBytes, timingSafeEqual, randomUUID }
export default cryptoShim
