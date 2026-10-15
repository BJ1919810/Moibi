import { useEffect, useState } from 'react'
import { api, LOCAL_MODE } from '../lib/api.js'

/**
 * 导出面板：选格式 + 选内容分区。
 * 书名与正文默认勾选；其余（简介、大纲、人物、伏笔、统计）按需添加。
 *
 * ⛔ 格式与分区的**权威清单在服务端**（`/api/export-options`，见 server/pipeline.js 的
 *    EXPORT_FORMATS / EXPORT_SECTIONS）—— 面板只负责渲染。
 *    下面的 FALLBACK_* 只用于「接口还没回来 / 服务不可达」时先把面板画出来；
 *    它们**必须**是服务端清单的子集，这一点由 `tests/export-options-single-source.test.js` 用源码扫描守住
 *    （抄一份不报错的清单，就等于「服务端下发了却没人读」再次发生）。
 */
const FALLBACK_FORMATS = [
  { key: 'md', label: 'Markdown', note: '保留标题层级，便于再排版' },
  { key: 'txt', label: '纯文本', note: '纯文字，随处分发' },
]

const FALLBACK_SECTIONS = [
  { key: 'title', label: '书名', hint: '作品标题', isDefault: true },
  { key: 'synopsis', label: '简介与主题', hint: '一句话梗概、题材、主题、文风', isDefault: false },
  { key: 'outline', label: '大纲', hint: '三幕结构、分卷目标、分章梗概', isDefault: false },
  { key: 'characters', label: '人物设定', hint: '角色身份、动机与隐秘', isDefault: false },
  { key: 'foreshadows', label: '伏笔清单', hint: '已埋线索与回收计划', isDefault: false },
  { key: 'body', label: '正文', hint: '已完成的章节全文', isDefault: true },
  { key: 'stats', label: '统计信息', hint: '章节数与字数', isDefault: false },
]

export default function ExportSheet({ project, onClose }) {
  const [formats, setFormats] = useState(FALLBACK_FORMATS)
  const [sections, setSections] = useState(FALLBACK_SECTIONS)
  const [format, setFormat] = useState('md')
  const [picked, setPicked] = useState(
    () => new Set(FALLBACK_SECTIONS.filter((s) => s.isDefault).map((s) => s.key)),
  )

  useEffect(() => {
    let alive = true
    api
      .getExportOptions()
      .then((r) => {
        if (!alive) return
        // ⚠️ 三件事都要做：分区、**格式**、以及「服务端默认勾选」——
        //    原来只读了 sections，formats 与 isDefault 都被丢掉（信息≠约束）
        if (r?.sections?.length) {
          setSections(r.sections)
          const defaults = r.sections.filter((s) => s.isDefault).map((s) => s.key)
          if (defaults.length) setPicked(new Set(defaults))
        }
        if (r?.formats?.length) {
          setFormats(r.formats)
          // 当前选中的格式若已不被支持（服务端改过），退到第一个可用项，别让界面留着一个无效选择
          setFormat((cur) => (r.formats.some((f) => f.key === cur) ? cur : r.formats[0].key))
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const toggle = (key) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const chosen = sections.filter((s) => picked.has(s.key))

  const [busy, setBusy] = useState(false)

  const download = async () => {
    const parts = chosen.map((s) => s.key)
    setBusy(true)
    try {
      if (LOCAL_MODE) {
        // App 内独立：后端不在网络里，取回文本内容再触发本地下载
        const { url, filename } = await api.exportBlobUrl(project.id, { format, parts })
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
        // 交给浏览器读完再回收，立刻 revoke 会导致下载中断
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      } else {
        const url = api.exportUrl(project.id, { format, parts })
        const a = document.createElement('a')
        a.href = url
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
      onClose()
    } catch (e) {
      window.alert(`导出失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="导出作品">
      <div className="sheet__mask" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <span className="sheet__title">导出《{project.title}》</span>
          <button className="sheet__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="sheet__scroll">
          <div className="sheet__label">文件格式</div>
          <div className="seg">
            {formats.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`seg__item${format === f.key ? ' is-on' : ''}`}
                onClick={() => setFormat(f.key)}
              >
                <b>{f.label}</b>
                <span>{f.note}</span>
              </button>
            ))}
          </div>

          <div className="sheet__label">
            导出内容
            <span className="sheet__hint">书名与正文已默认选中</span>
          </div>
          <ul className="checklist">
            {sections.map((s) => {
              const on = picked.has(s.key)
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    className={`check${on ? ' is-on' : ''}`}
                    onClick={() => toggle(s.key)}
                    aria-pressed={on}
                  >
                    <span className="check__box" aria-hidden="true" />
                    <span className="check__body">
                      <b>{s.label}</b>
                      <em>{s.hint}</em>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="sheet__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn--primary btn--grow"
            onClick={download}
            disabled={!chosen.length || busy}
          >
            {busy ? '正在导出…' : chosen.length ? `导出 ${chosen.length} 项` : '请至少选一项'}
          </button>
        </div>
      </div>
    </div>
  )
}
