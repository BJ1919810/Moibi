import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import Loading from '../components/Loading.jsx'

export default function Shelf({ hasKey, onNew, onOpen, onSettings }) {
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const { projects } = await api.listProjects()
      setList(projects || [])
    } catch (e) {
      setErr(e.message)
      setList([])
    }
  }

  useEffect(() => {
    load()
  }, [])

  const remove = async (ev, p) => {
    ev.stopPropagation()
    if (!window.confirm(`删除《${p.title || '未命名'}》？此操作不可恢复。`)) return
    try {
      await api.deleteProject(p.id)
      setList((s) => (s || []).filter((x) => x.id !== p.id))
    } catch (e) {
      setErr(e.message)
    }
  }

  return (
    <>
      <div className="hero">
        <div className="hero__seal">
          <span className="seal seal--lg">墨</span>
        </div>
        <h1 className="hero__title">墨笔</h1>
        <div className="hero__sub">一句话灵感　自动成书</div>
        <div className="hero__rule" />
      </div>

      {hasKey === false ? (
        <div className="notice notice--warn">
          还没配置模型密钥。
          <button className="link-btn" onClick={onSettings}>
            去设置 →
          </button>
        </div>
      ) : null}

      {err ? <div className="notice notice--err">{err}</div> : null}

      {list === null ? (
        <Loading text="正在取书……" />
      ) : list.length === 0 ? (
        <div className="empty">
          书架上还空着。
          <br />
          写下一个念头，墨笔替你铺开整本书。
        </div>
      ) : (
        <div className="shelf">
          {list.map((p) => (
            <div key={p.id} className="card book-card" onClick={() => onOpen(p)} role="button" tabIndex={0}>
              <span className="book-card__spine" />
              <button
                className="book-card__del"
                onClick={(ev) => remove(ev, p)}
                aria-label="删除作品"
              >
                ×
              </button>
              <div className="book-card__body">
                <div className="book-card__name">{p.title || '未命名'}</div>
                <div className="book-card__idea">{p.idea}</div>
                <div className="book-card__meta">
                  <span className="tag">{p.genre}</span>
                  <span>
                    已写 {p.chapterCount}/{p.plannedCount || '—'} 章
                  </span>
                  <BookCost usage={p.usage} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="spacer" />
      <button className="btn btn--primary btn--lg" onClick={onNew}>
        写一个新的故事
      </button>
    </>
  )
}

function BookCost({ usage }) {
  if (!usage || !usage.calls) return null
  const total = (usage.inputTokens || 0) + (usage.outputTokens || 0)
  return <span>{total > 0 ? `${(total / 1000).toFixed(1)}k tokens` : ''}</span>
}
