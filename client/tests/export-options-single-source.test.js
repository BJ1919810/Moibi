import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORT_FORMATS, EXPORT_SECTIONS } from '../server/pipeline.js'

/**
 * 导出面板的清单**只有一份**（服务端），前端只负责渲染。
 *
 * 背景：`/api/export-options` 一直在下发 `formats`，而前端从不读它 —— 自己抄了一份带
 * label/note 的 `FORMATS`（典型的「信息≠约束」/「有读无写」的镜像：
 * 服务端下发了却没人读）。修法两半：
 *   ① 服务端把 label/note 一并下发（与早就这么做的 `EXPORT_SECTIONS` 同形状）；
 *   ② 前端渲染服务端那份，只留**降级用**的兜底常量。
 * 这里锁住第 ② 半的不变量：兜底清单只能是服务端清单的**子集**
 *（可以滞后、不许多出服务端不支持的项 —— 多出来的键会被服务端拒绝或静默忽略）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SHEET = fs.readFileSync(path.join(ROOT, 'src/components/ExportSheet.jsx'), 'utf8')

/** 从 JSX 源码里抽出某个 FALLBACK_* 数组的 key 列表（不执行前端代码） */
function fallbackKeys(name) {
  const m = SHEET.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`))
  assert.ok(m, `ExportSheet.jsx 里找不到 ${name}`)
  return [...m[1].matchAll(/key:\s*'([^']+)'/g)].map((x) => x[1])
}

test('服务端下发的 formats 必须带 label/note（否则前端只能自己抄文案）', () => {
  const entries = Object.entries(EXPORT_FORMATS)
  assert.ok(entries.length >= 2, '至少要有 md / txt 两种')
  for (const [key, v] of entries) {
    assert.equal(typeof v.label, 'string', `${key} 缺 label`)
    assert.ok(v.label.trim(), `${key} 的 label 不能为空`)
    assert.equal(typeof v.note, 'string', `${key} 缺 note`)
    assert.ok(v.ext, `${key} 缺 ext`)
  }
  for (const s of EXPORT_SECTIONS) {
    assert.ok(s.key && s.label && s.hint, `分区 ${s.key} 缺 label/hint`)
  }
})

test('前端兜底清单是服务端清单的子集（可以滞后，不许多出服务端不支持的项）', () => {
  const serverFormats = Object.keys(EXPORT_FORMATS)
  const serverSections = EXPORT_SECTIONS.map((s) => s.key)
  const fbFormats = fallbackKeys('FALLBACK_FORMATS')
  const fbSections = fallbackKeys('FALLBACK_SECTIONS')

  assert.ok(fbFormats.length && fbSections.length, '兜底清单不能为空')
  for (const k of fbFormats) assert.ok(serverFormats.includes(k), `前端兜底格式「${k}」服务端并不支持`)
  for (const k of fbSections) assert.ok(serverSections.includes(k), `前端兜底分区「${k}」服务端并不支持`)
})

test('⛔ 前端不许再有第二份「权威」格式清单（源码扫描：不得出现 const FORMATS = …）', () => {
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(js|jsx)$/.test(e.name)) continue
      const text = fs.readFileSync(p, 'utf8')
      // FALLBACK_* 是允许的降级项；裸的 FORMATS/SECTIONS 常量就是又抄了一份权威清单
      if (/const\s+(FORMATS|SECTIONS)\s*=/.test(text)) offenders.push(path.relative(ROOT, p))
    }
  }
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(offenders, [], `这些文件里的格式/分区清单应改为从服务端下发：\n${offenders.join('\n')}`)
})
