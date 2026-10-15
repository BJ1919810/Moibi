/**
 * 目录面板：底部弹出，列出已定稿章节。
 * 只列已写章节 —— 未写章节没有正文，点进去会是空白，读者不需要看到占位。
 */
export default function ChapterList({ project, chapterNo, onPick, onClose }) {
  const chapters = [...(project.chapters || [])].sort((a, b) => a.no - b.no)

  return (
    <div className="bsheet-mask" onClick={onClose} role="presentation">
      <div className="bsheet bsheet--toc" role="dialog" aria-modal="true" aria-label="目录" onClick={(e) => e.stopPropagation()}>
        <div className="bsheet__grip" aria-hidden="true" />
        <div className="bsheet__head">
          <b>目录</b>
          <span className="setting-note" style={{ margin: 0 }}>共 {chapters.length} 章</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>关闭</button>
        </div>
        <div className="toc">
          {chapters.length ? chapters.map((c) => (
            <button type="button" key={c.no}
              className={`toc__item${c.no === chapterNo ? ' toc__item--on' : ''}`}
              onClick={() => onPick(c.no)}>
              <span className="toc__no">第 {c.no} 章</span>
              <span className="toc__name">{c.title}</span>
              <span className="toc__meta">{c.wordCount || 0} 字</span>
            </button>
          )) : <div className="empty">还没有正文。</div>}
        </div>
      </div>
    </div>
  )
}
