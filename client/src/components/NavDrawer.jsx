/**
 * 作品导航抽屉（v1 的「侧边栏式抽屉」结构）。
 * 只负责导航与出口，不改任何作品数据；出口一律走已有回调。
 */
export default function NavDrawer({ open, onClose, project, view, onNav, onExport, onHome, onAssistant, onMaterials }) {
  if (!open || !project) return null

  const chapters = project.chapters || []
  const done = chapters.filter((c) => c.status === 'committed').length || chapters.length
  const hasChapters = chapters.length > 0
  const tags = (project.genreTags?.length ? project.genreTags : [project.genre]).filter(Boolean)

  // 所有出口先关抽屉，再执行动作，避免抽屉盖在新页面上。
  const run = (fn) => { onClose(); fn() }
  const pick = (id) => {
    if (id === 'assistant') return run(() => onAssistant?.('请结合这部作品提供定向建议，不要自动修改资料。'))
    if (id === 'materials') return run(() => onMaterials?.())
    return run(() => onNav(id))
  }

  const items = [
    { id: 'outline', icon: '📜', label: '剧情大纲' },
    { id: 'write', icon: '✍️', label: chapters.length ? '章节续写' : '开始执笔', badge: done || null },
    hasChapters ? { id: 'read', icon: '📖', label: '阅读正文' } : null,
    { id: 'materials', icon: '🗂', label: '创作资料与编辑' },
    { id: 'direction', icon: '🧭', label: '剧情方向修改' },
    { id: 'assistant', icon: '💬', label: 'AI 助手' },
    { id: 'settings', icon: '⚙️', label: '设置' },
  ].filter(Boolean)

  return (
    <div className="drawer-mask" onClick={onClose} role="presentation">
      <aside className="nav-drawer" role="dialog" aria-modal="true" aria-label="作品导航" onClick={(e) => e.stopPropagation()}>
        <div className="nav-drawer__head">
          {tags.length ? <div className="nav-drawer__tags">{tags.join(' / ')}</div> : null}
          <h2 className="nav-drawer__title">《{project.title || '未命名'}》</h2>
          {project.idea ? <p className="nav-drawer__idea">{project.idea}</p> : null}
          <div className="nav-drawer__rule" />
        </div>

        <nav className="nav-list">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className={`nav-item${view === it.id ? ' nav-item--on' : ''}`}
              onClick={() => pick(it.id)}
            >
              <span className="nav-item__icon" aria-hidden="true">{it.icon}</span>
              <span className="nav-item__label">{it.label}</span>
              {it.badge ? <span className="nav-item__badge">{it.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className="nav-drawer__foot">
          <button className="btn btn--gold btn--lg" onClick={() => run(onExport)} disabled={!hasChapters}>一键导出</button>
          <button className="btn btn--ghost btn--lg" onClick={() => run(onHome)}>返回书案</button>
        </div>
      </aside>
    </div>
  )
}
