import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toParagraphs } from '../lib/api.js'
import { loadReaderPrefs, saveReaderPrefs, readerStyle, pageStep } from '../lib/reader-prefs.js'
import ReaderSettings from '../components/ReaderSettings.jsx'
import ChapterList from '../components/ChapterList.jsx'

/**
 * 独立阅读页（番茄小说式）。
 *
 * 设计目标：这是一个**给人看小说**的页面，不是创作工具的一个视图。
 *   · 顶栏只留「返回 + 章节名」，没有作品管理味；
 *   · 底部固定「上一章 / 进度滑块 / 下一章」+ 三个圆形按钮「目录 / 续写 / 设置」；
 *   · 设置从底部弹出约 1/3 屏面板，调字号、行高、段间距、翻页方式、音量键换页；
 *   · 阅读偏好只存本机（见 lib/reader-prefs.js）。
 *
 * 返回键：本页接管 Android 返回键的**第一优先**，依次
 *   关设置面板 → 关目录 → 退出阅读（交还 App 栈）→ 交还浏览器/系统。
 *   这样在阅读时按返回不会直接跳出应用。
 */
export default function Reader({ project, chapterNo, onChangeNo, onWriteNext, onExport, onBack, guardRef }) {
  const chapters = useMemo(
    () => [...(project.chapters || [])].sort((a, b) => a.no - b.no),
    [project]
  )
  const total = project.outline?.totalChapters || 0

  const [prefs, setPrefs] = useState(loadReaderPrefs)
  const [showSettings, setShowSettings] = useState(false)
  const [showToc, setShowToc] = useState(false)
  /** 状态栏（顶栏 + 进度条 + 工具条）是否可见。点正文中间一次淡出，再点一次淡入。 */
  const [barVisible, setBarVisible] = useState(true)
  /** 左右翻页模式下「一列」的宽度（px）：内容盒宽度，由 ResizeObserver 量出来。 */
  const [colW, setColW] = useState(0)
  const [progress, setProgress] = useState(0)
  const scroller = useRef(null)

  let i = chapters.findIndex((c) => c.no === chapterNo)
  if (i < 0) i = chapters.length - 1
  const cur = chapters[i]
  const prev = i > 0 ? chapters[i - 1] : null
  const next = i < chapters.length - 1 ? chapters[i + 1] : null

  /* 偏好持久化 */
  useEffect(() => { saveReaderPrefs(prefs) }, [prefs])

  /**
   * 返回键守卫：把自己「是否还要拦这一下」注册给 App。
   * 返回 true = 已消费（关掉了一个面板），返回 false = 交还给 App 退出阅读。
   * 用 ref 读最新 state，避免把监听器绑在会频繁变化的 state 上。
   */
  const panelRef = useRef({ showSettings, showToc })
  panelRef.current = { showSettings, showToc }
  useEffect(() => {
    if (!guardRef) return
    guardRef.current = () => {
      const { showSettings: s, showToc: t } = panelRef.current
      if (s) { setShowSettings(false); return true }
      if (t) { setShowToc(false); return true }
      return false
    }
    return () => { guardRef.current = null }
  }, [guardRef])

  /* 换章后回到顶部并重置进度 */
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = 0
    setProgress(0)
  }, [chapterNo])

  /**
   * 本章阅读进度 —— 滚动模式看纵向、左右翻页模式看横向。
   *
   * ⛔ 原来这里**只算纵向**，于是左右翻页模式下进度恒为 0（页面模式纵向锁死），
   *    界面只好改用「第几章 / 共几章」顶替。现在两种模式都给出**本章内**的进度：
   *    进度条据此显示，也据此跳转（跳章交给 ‹ › 与目录，1% 的拖动不该跨好几章）。
   */
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const page = prefs.pageMode === 'page'
    const max = page ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    const pos = page ? el.scrollLeft : el.scrollTop
    setProgress(max > 0 ? Math.min(1, Math.max(0, pos / max)) : 0)
  }, [prefs.pageMode])

  /** 拖动进度条 = **在本章内跳转**（原来它是 `readOnly` 的纯指示器，拖不动） */
  const seek = useCallback((e) => {
    const el = scroller.current
    if (!el) return
    const p = Math.min(1, Math.max(0, Number(e.target.value) / 100))
    if (prefs.pageMode === 'page') el.scrollTo({ left: p * (el.scrollWidth - el.clientWidth), behavior: 'auto' })
    else el.scrollTo({ top: p * (el.scrollHeight - el.clientHeight), behavior: 'auto' })
    setProgress(p)
  }, [prefs.pageMode])

  const goto = useCallback((no) => {
    if (no == null) return
    onChangeNo(no)
    setShowToc(false)
  }, [onChangeNo])

  /**
   * 翻页（两种翻页方式共用同一个入口）。
   *
   * ⛔ 原先这里只做横向 `scrollBy({left})`，而**默认是上下滚动模式** ⇒
   *    在手机上点左右两边什么都不会发生（用户报的就是这个）。
   *    现在按 `pageMode` 分流：
   *      · 上下滚动：一次一屏**纵向**（点右边=往下翻一屏，点左边=往上翻一屏）；
   *      · 左右翻页：一次一列**横向**（列宽正好一屏，所以步长取整屏宽，不要 0.92 留边）。
   *    到边界则切上一章 / 下一章。
   */
  const flip = useCallback((dir) => {
    const el = scroller.current
    if (!el) return
    const page = prefs.pageMode === 'page'
    const pos = page ? el.scrollLeft : el.scrollTop
    const size = page ? el.clientWidth : el.clientHeight
    const max = page ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    if (dir > 0 && pos + size >= max - 4 && next) return goto(next.no)
    if (dir < 0 && pos <= 4 && prev) return goto(prev.no)
    // 列宽 = 一列正文的宽度 ⇒ 步长必须是它（用 clientWidth 会把内边距也算进去，越翻越偏）
    const step = page ? (colW || pageStep(el)) : Math.max(1, Math.round(size * 0.92))
    el.scrollBy(page ? { left: dir * step, behavior: 'smooth' } : { top: dir * step, behavior: 'smooth' })
  }, [next, prev, goto, prefs.pageMode, colW])

  /**
   * 点击分区：左 30% 上一屏 / 右 30% 下一屏 / 中间 40% 开关状态栏。
   *
   * 为什么用 pointerdown+pointerup 而不是 onClick：滚动、拖拽、选词结束时也会派发 click，
   * 那样一滑动就会误翻页。这里只在「按下与抬起几乎同一点、且时间很短、且没有选中文字」时才算点击。
   */
  const tapStart = useRef(null)
  const onBodyPointerDown = useCallback((e) => {
    tapStart.current = { x: e.clientX, y: e.clientY, t: Date.now() }
  }, [])
  const onBodyPointerUp = useCallback((e) => {
    const start = tapStart.current
    tapStart.current = null
    if (!start) return
    if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) return
    if (Date.now() - start.t > 700) return
    if (String(window.getSelection?.() || '').trim()) return
    const el = scroller.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
    if (x < 0.3) return flip(-1)
    if (x > 0.7) return flip(1)
    setBarVisible((v) => !v)
  }, [flip])

  /**
   * 键盘翻页：← → ↑ ↓ / PageUp / PageDown / 空格。
   * ⚠️ **只在状态栏隐藏时接管** —— 状态栏可见时用户正在操作界面（进度条、按钮），
   *    这时不该被翻页抢走方向键。
   */
  useEffect(() => {
    if (barVisible) return
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (['input', 'textarea', 'select'].includes(tag)) return
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); flip(1) }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); flip(-1) }
      else if (e.key === 'Escape') setBarVisible(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [barVisible, flip])

  /**
   * 量出「一列」的宽度：内容盒宽度（clientWidth 减去左右内边距）。
   *
   * ⛔ 为什么必须在 JS 里量：`column-width` **不接受百分比**，写 `100%` 会被整条丢弃、
   *    计算值退化成 `auto` ⇒ 完全不分列，正文被 `overflow-y:hidden` 裁掉。
   *    而列宽必须等于**内容盒**宽度（不是 clientWidth —— 那会把内边距也算进去，越翻越偏）。
   *    窗口尺寸/字号/方向一变就要重量，所以挂 ResizeObserver。
   */
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const inner = el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0)
      setColW(Math.max(1, Math.round(inner)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 左右翻页模式：滚动停下后**吸附到页边界**。
   *
   * ⛔ 只 `scrollBy` 不吸附的话，手指横向一拖就会停在两列中间 —— 那是「滚动」不是「翻页」
   *    （主人原话：左右翻页为什么能翻页不彻底？是左右翻页，不是左右滚动）。
   *    这里在滚动停止（140ms 无事件）后把 `scrollLeft` 对齐到最近的整列。
   */
  useEffect(() => {
    if (prefs.pageMode !== 'page') return
    const el = scroller.current
    if (!el) return
    let timer = null
    const snap = () => {
      const w = colW || el.clientWidth
      if (!(w > 0)) return
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      const target = Math.max(0, Math.min(Math.round(el.scrollLeft / w) * w, max))
      if (Math.abs(el.scrollLeft - target) > 1) el.scrollTo({ left: target, behavior: 'smooth' })
    }
    const onPageScroll = () => { clearTimeout(timer); timer = setTimeout(snap, 140) }
    el.addEventListener('scroll', onPageScroll, { passive: true })
    return () => { clearTimeout(timer); el.removeEventListener('scroll', onPageScroll) }
  }, [prefs.pageMode, colW])

  /**
   * 沉浸阅读时锁住**文档级**滚动。
   *
   * ⛔ 用户报「换成左右翻页时整个页面能被上下拖动」的根因就在这里：
   *    `tokens.css` 只设了 `body{overflow-x:hidden}`，**纵向没锁**；而 `.reader-page`
   *    是 `100dvh` 装在容器里，溢出哪怕一两像素，滚的就是**整个文档**。
   *    页面模式只禁掉了正文容器自己的纵向滚动，文档级滚动还在。
   *    （不能全局给 body 加 overflow:hidden —— 其它页面正是靠文档流滚动的。）
   */
  useEffect(() => {
    document.documentElement.classList.add('reader-open')
    return () => document.documentElement.classList.remove('reader-open')
  }, [])

  /* 音量键换页：网页拿不到音量键，只接受 App 壳桥接过来的事件 */
  useEffect(() => {
    if (!prefs.volumeKeys) return
    const onKey = (e) => {
      const k = e.key || ''
      if (!/^Volume(Up|Down)$/.test(k)) return
      e.preventDefault()
      flip(k === 'VolumeUp' ? 1 : -1)
    }
    const onBridge = (e) => flip(Number(e?.detail) >= 0 ? 1 : -1)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mobi:volume-key', onBridge)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mobi:volume-key', onBridge)
    }
  }, [prefs.volumeKeys, flip])

  if (!chapters.length) {
    return <div className="empty">这部作品还没有正文。</div>
  }

  const isPage = prefs.pageMode === 'page'
  const pct = total ? Math.round(((cur.no) / total) * 100) : Math.round(progress * 100)

  return (
    <div className={`reader-page${barVisible ? '' : ' reader-page--bare'}`}>
      <div className="reader-page__top">
        <button className="icon-btn" onClick={() => onBack?.()} aria-label="返回">‹</button>
        <div className="reader-page__top-title">{cur.title}</div>
        <div className="reader-page__top-sub">第 {cur.no} 章</div>
      </div>

      <div
        ref={scroller}
        className={`reader-page__body${isPage ? ' reader-page__body--page' : ''}`}
        style={isPage && colW ? { ...readerStyle(prefs), columnWidth: `${colW}px` } : readerStyle(prefs)}
        onScroll={onScroll}
        onPointerDown={onBodyPointerDown}
        onPointerUp={onBodyPointerUp}
      >
        <div className="reader__vol">{cur.volumeTitle || project.title}</div>
        <div className="reader__body-text">
          {toParagraphs(cur.text).map((p, k) => <p key={k}>{p}</p>)}
        </div>
        <div className="reader__end">— 本章完 —</div>
      </div>

      <div className="reader-page__bar">
        <button className="icon-btn" disabled={!prev} onClick={() => goto(prev?.no)} aria-label="上一章">‹</button>
        <input className="reader-page__slider" type="range" aria-label="阅读进度" min={0} max={100} step={1}
          value={Math.round(progress * 100)} onChange={seek} style={{ flex: 1 }} />
        <button className="icon-btn" disabled={!next} onClick={() => goto(next?.no)} aria-label="下一章">›</button>
      </div>

      <div className="reader-page__tools">
        <button className="tool-item" onClick={() => setShowToc(true)}>
          <span className="tool-item__icon" aria-hidden="true">☰</span>
          <span className="tool-item__label">目录</span>
        </button>
        <button className="tool-item" onClick={onWriteNext}>
          <span className="tool-item__icon" aria-hidden="true">✎</span>
          <span className="tool-item__label">续写</span>
        </button>
        <button className="tool-item" onClick={() => setShowSettings(true)}>
          <span className="tool-item__icon" aria-hidden="true">⚙</span>
          <span className="tool-item__label">设置</span>
        </button>
      </div>

      {showToc ? (
        <ChapterList project={project} chapterNo={cur.no} onPick={goto} onClose={() => setShowToc(false)} />
      ) : null}
      {showSettings ? (
        <ReaderSettings prefs={prefs} onChange={setPrefs} onClose={() => setShowSettings(false)} />
      ) : null}
    </div>
  )
}
