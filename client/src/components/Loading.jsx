export default function Loading({ text = '正在研墨……', hint = '' }) {
  return (
    <div className="loading">
      <div className="loading__ring" />
      <div className="loading__text">{text}</div>
      {hint ? <div className="loading__hint">{hint}</div> : null}
    </div>
  )
}
