/**
 * 把一本书导出为 txt / md（可导入番茄）。
 *
 * 用法：
 *   node scripts/export-txt.mjs --project p_xxx
 *   node scripts/export-txt.mjs --project p_xxx --from 1 --to 10 --name 书名
 *
 * 产出：mobi/outputs/<书名>.txt 与 <书名>.md
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, 'outputs')

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const pid = arg('project')
if (!pid) { console.error('需要 --project p_xxx'); process.exit(1) }
const from = Number(arg('from', 1))
const to = Number(arg('to', 9999))

const p = JSON.parse(readFileSync(resolve(ROOT, `data/projects/${pid}.json`), 'utf8'))
const title = arg('name', p.title || '未命名')
const chs = (p.chapters || []).filter((c) => c.text && c.no >= from && c.no <= to).sort((a, b) => a.no - b.no)
if (!chs.length) { console.error('没有可导出的章节'); process.exit(1) }

mkdirSync(OUT, { recursive: true })

// TXT：番茄等平台友好的纯文本，章节标题单独一行
const txt = [
  title,
  '',
  `（共 ${chs.length} 章 / ${chs.reduce((s, c) => s + c.text.length, 0)} 字）`,
  '',
  ...chs.flatMap((c) => [`第${c.no}章 ${c.title || ''}`.trim(), '', c.text.trim(), '', '']),
].join('\n')

// MD：带层级的可读版本
const md = [
  `# ${title}`,
  '',
  `> 共 ${chs.length} 章 / ${chs.reduce((s, c) => s + c.text.length, 0)} 字`,
  '',
  ...chs.flatMap((c) => [`## 第${c.no}章 ${c.title || ''}`.trim(), '', c.text.trim(), '', '---', '']),
].join('\n')

// HTML：方便直接在浏览器里读
const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{max-width:40em;margin:0 auto;padding:2.5rem 1.25rem 6rem;background:#faf9f7;color:#22201e;
       font:16px/1.95 Georgia,"Songti SC","Noto Serif CJK SC",serif}
  h1{font-size:1.6rem;text-align:center;margin:0 0 .4rem;letter-spacing:.05em}
  .meta{text-align:center;color:#8a857e;font-size:.85rem;margin-bottom:3rem}
  h2{font-size:1.05rem;margin:3.5rem 0 1.4rem;color:#5c5650;font-weight:600;letter-spacing:.04em}
  p{margin:0 0 1.15em;text-indent:2em}
  hr{border:0;border-top:1px solid #e6e1da;margin:3rem 0}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">共 ${chs.length} 章 / ${chs.reduce((s, c) => s + c.text.length, 0)} 字</div>
${chs.map((c) => `<h2>第${c.no}章 ${esc(c.title || '')}</h2>
${c.text.trim().split(/\n{2,}/).map((para) => `<p>${esc(para.trim()).replace(/\n/g, '<br>')}</p>`).join('\n')}
<hr>`).join('\n')}
</body></html>`

writeFileSync(resolve(OUT, `${title}.txt`), txt, 'utf8')
writeFileSync(resolve(OUT, `${title}.md`), md, 'utf8')
writeFileSync(resolve(OUT, `${title}.html`), html, 'utf8')
console.log(`已导出《${title}》 ${chs.length} 章 / ${chs.reduce((s, c) => s + c.text.length, 0)} 字`)
console.log(' ', resolve(OUT, `${title}.txt`))
console.log(' ', resolve(OUT, `${title}.md`))
console.log(' ', resolve(OUT, `${title}.html`))
