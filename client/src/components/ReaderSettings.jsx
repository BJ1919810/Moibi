import { FONT_RANGE, GAP_RANGE, LINE_RANGE, READER_DEFAULTS } from '../lib/reader-prefs.js'

/**
 * 阅读设置面板：从屏幕下方弹出，约 1/3 屏高。
 *
 * 布局取向（对齐参考的阅读类 App）：标签与数值与滑块**同排**，
 * 不各占一行 —— 面板只有 1/3 屏，纵向空间要留给控件本身而不是标签。
 * 项目：翻页方式、字体大小、行高、段间距、音量键换页。
 * 所有改动即时生效（受控），持久化由 Reader 统一负责。
 */
export default function ReaderSettings({ prefs, onChange, onClose }) {
  const set = (patch) => onChange({ ...prefs, ...patch })
  const val = { ...READER_DEFAULTS, ...prefs }

  const Row = ({ label, value, min, max, step, field, unit = '' }) => {
    const cur = Number(val[field])
    /** ± 步进：拖滑条容易误触（手一滑就改值），这里给一对按钮做精确调整 */
    const bump = (dir) => {
      const next = Math.min(max, Math.max(min, Number((cur + dir * step).toFixed(2))))
      if (next !== cur) set({ [field]: next })
    }
    return (
      <div className="rset__row">
        <span className="rset__k">{label}</span>
        <button type="button" className="rset__step" aria-label={`${label}调小`} onClick={() => bump(-1)}>−</button>
        <input type="range" className="chapter-range" aria-label={label}
          min={min} max={max} step={step} value={val[field]}
          onChange={(e) => set({ [field]: Number(e.target.value) })} />
        <button type="button" className="rset__step" aria-label={`${label}调大`} onClick={() => bump(1)}>+</button>
        <span className="rset__v">{typeof val[field] === 'number' && step < 1 ? val[field].toFixed(1) : val[field]}{unit}</span>
      </div>
    )
  }

  return (
    <div className="bsheet-mask" onClick={onClose} role="presentation">
      <div className="bsheet bsheet--reader" role="dialog" aria-modal="true" aria-label="阅读设置" onClick={(e) => e.stopPropagation()}>
        <div className="bsheet__grip" aria-hidden="true" />
        <div className="bsheet__head">
          <b>阅读设置</b>
          <button type="button" className="link-btn" style={{ marginLeft: 'auto' }}
            onClick={() => onChange({ ...READER_DEFAULTS, pageMode: val.pageMode, volumeKeys: val.volumeKeys })}>
            恢复默认
          </button>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>关闭</button>
        </div>

        <div className="rset">
          <div className="rset__row">
            <span className="rset__k">翻页</span>
            <div className="seg">
              <button type="button" className={`seg__item${val.pageMode === 'scroll' ? ' seg__item--on' : ''}`}
                onClick={() => set({ pageMode: 'scroll' })}>上下滚动</button>
              <button type="button" className={`seg__item${val.pageMode === 'page' ? ' seg__item--on' : ''}`}
                onClick={() => set({ pageMode: 'page' })}>左右翻页</button>
            </div>
          </div>

          <Row label="字号" field="fontSize" unit="px" {...FONT_RANGE} />
          <Row label="行高" field="lineHeight" {...LINE_RANGE} />
          <Row label="段距" field="paragraphGap" unit="px" {...GAP_RANGE} />

          <label className="rset__switch">
            <span>
              音量键换页
              <span className="rset__hint">仅在 App 壳 / WebView 内生效；浏览器与 PWA 中网页无法读取音量键。</span>
            </span>
            <input type="checkbox" checked={!!val.volumeKeys}
              onChange={(e) => set({ volumeKeys: e.target.checked })} />
          </label>
        </div>
      </div>
    </div>
  )
}
