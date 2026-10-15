import { useEffect, useRef, useState } from 'react'
import { api } from './lib/api.js'
import { resolveBack, backFallback, BACK_PANEL, BACK_NAVIGATED, BACK_EXIT, BACK_INCONSISTENT } from './lib/back-nav.js'
import { isNativeShell } from './lib/native-shell.js'
import Loading from './components/Loading.jsx'
import ExportSheet from './components/ExportSheet.jsx'
import Shelf from './screens/Shelf.jsx'
import Create from './screens/Create.jsx'
import Outline from './screens/Outline.jsx'
import Write from './screens/Write.jsx'
import Reader from './screens/Reader.jsx'
import Settings from './screens/Settings.jsx'
import Direction from './screens/Direction.jsx'
import Assistant from './screens/Assistant.jsx'
import NavDrawer from './components/NavDrawer.jsx'
import CreationDrawer from './components/CreationDrawer.jsx'

function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop__char backdrop__char--1">墨</div>
      <div className="backdrop__char backdrop__char--2">筆</div>
    </div>
  )
}

export default function App() {
  const [stack, setStack] = useState(['shelf'])
  const [project, setProject] = useState(null)
  const [readingNo, setReadingNo] = useState(1)
  const [config, setConfig] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [assistantText, setAssistantText] = useState('')
  const [assistantFrom, setAssistantFrom] = useState('作品')
  const [navOpen, setNavOpen] = useState(false)

  const view = stack[stack.length - 1]
  /**
   * 「AI 助手」与「创作资料与编辑」现在是**整页**，不是浮层。
   *
   * 为什么改：主人指出它们明明该跟「剧情方向修改」一样是完整页面，
   * 却仍做成右侧滑入的浮窗（带 ✕、点目录会把整页关掉）。
   * 改成页面后它们进入同一个页面栈，返回键/浏览器返回的语义自动一致，
   * 也不需要再往 `resolveBack` 里登记什么「浮层」。
   */
  const openAssistant = (text = '', from = '作品') => {
    setAssistantText(text)
    setAssistantFrom(from)
    setStack((s) => (s[s.length - 1] === 'assistant' ? s : [...s, 'assistant']))
    scrollTop()
  }
  // 阅读页自成一体（自带顶栏/底栏），不再套全局顶栏与页面内边距。
  const immersive = view === 'read'

  const refreshConfig = () =>
    api
      .getConfig()
      .then(setConfig)
      .catch(() => setConfig({ hasKey: false, model: '', baseURL: '' }))

  useEffect(() => {
    refreshConfig()
  }, [])

  const scrollTop = () => window.scrollTo({ top: 0 })

  const push = (v) => {
    setStack((s) => [...s, v])
    scrollTop()
  }
  const back = () => {
    setExportOpen(false)
    setNavOpen(false)
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    scrollTop()
  }
  const home = () => {
    setExportOpen(false)
    setNavOpen(false)
    setStack(['shelf'])
    setProject(null)
    scrollTop()
  }
  const openProject = async (p) => {
    setProject(p)
    setExportOpen(false)
    push('outline')
    try {
      // 列表接口只返回摘要，详情要单独拉全量（含大纲与正文）
      const { project: full } = await api.getProject(p.id)
      setProject(full)
    } catch {
      /* 拉取失败就先用摘要显示，至少不白屏 */
    }
  }

  // 作品内导航（抽屉入口）：固定「书架 → 大纲 → 目标页」层级，不无限叠加历史。
  const navTo = (target) => {
    if (!project) return
    setExportOpen(false)
    if (target === 'settings') return push('settings')
    if (target === 'write') {
      setStack(['shelf', 'outline', 'write'])
      return scrollTop()
    }
    if (target === 'read') {
      const nos = (project.chapters || []).map((c) => c.no)
      setReadingNo(nos.length ? Math.max(...nos) : 1)
      setStack(['shelf', 'outline', 'read'])
      return scrollTop()
    }
    // 创作资料与 AI 助手现在也是页面，层级同样固定为「书架 → 大纲 → 目标页」
    if (target === 'direction' || target === 'materials' || target === 'assistant') {
      if (target === 'assistant') setAssistantFrom('作品')
      setStack(['shelf', 'outline', target])
      return scrollTop()
    }
    setStack(['shelf', 'outline'])
    scrollTop()
  }
  // 顶栏显示「☰ + 标题」的视图（作品内页面）。assistant 虽不在项目内
  // 的语境里，但同样由 ☰ 进出，所以并列。
  const inProject = !!project && ['outline', 'write', 'read', 'direction', 'materials', 'assistant'].includes(view)

  const titles = {
    shelf: '墨笔',
    create: '新的故事',
    outline: project?.title || '故事大纲',
    write: '执笔',
    read: project?.chapters?.find((c) => c.no === readingNo)?.title || '阅读',
    direction: '剧情方向修改',
    materials: '创作资料与编辑',
    assistant: 'AI 助手',
    settings: '设置',
  }

  /* ------------------------- 返回键 / 浏览器历史 ------------------------- */
  // 两套机制，按运行形态二选一：
  //
  //  · 网页形态（电脑/局域网）：浏览器返回 = popstate。阅读页要接管它，
  //    所以进入阅读时压一条历史记录；阅读组件把自己「是否还要拦这一下」
  //    注册到 readerGuardRef（设置/目录面板开着 ⇒ 先关面板、继续拦）。
  //
  //  · Android 原生壳：**WebView 不会收到 popstate** —— Capacitor 核心不接管
  //    返回键，系统默认直接 finish() 掉 Activity，表现就是「按一下直接退出
  //    应用」。所以必须显式订阅 @capacitor/app 的 backButton 事件来自接管。
  //    （这也是之前在浏览器里测「看起来绑好了」的假象来源。）
  //
  // 全程只有 App 一处返回处理，避免两个监听器各退一步把用户顶出应用。
  const inNativeShell = isNativeShell()

  const historyPushed = useRef(false)
  const readerGuardRef = useRef(null)

  /**
   * 统一的「返回上一级」。
   *
   * 返回 'panel'     —— 关掉了一个浮层/面板（导航抽屉、导出、助手、阅读设置…）
   * 返回 'navigated' —— 退回上一层页面（写 → 大纲 → 书架）
   * 返回 'exit'      —— 已在最外层（书架），交给系统处理
   *
   * 用 ref 暴露最新实现，监听器只注册一次、不随 state 反复重绑。
   */
  const onBackRequestRef = useRef(() => 'exit')
  onBackRequestRef.current = () => {
    // 浮层只剩「导出」与「作品导航」两个。
    // （AI 助手 / 创作资料改成整页后已进页面栈，不再走这里 —— 这正是改造的收益：
    //  页面层级的返回语义由 stack 统一决定，不需要每加一个入口就登记一次。）
    const overlays = { export: exportOpen, nav: navOpen }
    const what = resolveBack({ overlays, view, stack })
    if (what === BACK_INCONSISTENT) {
      // 只在状态真的坏了时走到这里：把浮层全收干净，页面原地不动。
      setExportOpen(false)
      setNavOpen(false)
      return backFallback()
    }
    if (what === BACK_PANEL) {
      // 关掉当前那一层浮层（同一时刻只会有一层，见 resolveBack 的注释）
      if (navOpen) setNavOpen(false)
      else if (exportOpen) setExportOpen(false)
      return BACK_PANEL
    }
    if (what === BACK_NAVIGATED) {
      // 阅读页内的次级面板（设置 / 目录）挡在前面：先关它，页面不动
      if (view === 'read' && readerGuardRef.current?.()) return BACK_PANEL
      back()
      return BACK_NAVIGATED
    }
    return BACK_EXIT
  }

  // —— 原生壳：订阅 Android 硬件返回键 ——
  // 不订阅的话，Capacitor 核心不接管返回键，系统会直接 finish() 掉 Activity，
  // 表现就是「按一下直接退出应用」。这里接管后：逐层退回，只在书架层退出。
  useEffect(() => {
    if (!inNativeShell) return
    let disposed = false
    let handle = null
    import('@capacitor/app')
      .then(({ App }) => {
        if (disposed) return
        App.addListener('backButton', () => {
          if (onBackRequestRef.current() === 'exit') App.exitApp().catch(() => {})
        }).then((h) => { handle = h })
      })
      .catch(() => { /* 插件缺失时交给 WebView 默认行为，不至于崩 */ })
    return () => {
      disposed = true
      try { handle?.remove?.() } catch { /* 忽略 */ }
    }
  }, [inNativeShell])

  // —— 网页形态：每条「非书架」历史各压一条哨兵记录，让浏览器返回 = 退上一层 ——
  // 原生壳不压：返回键已由 backButton 事件接管，WebView 历史留着不动更干净。
  useEffect(() => {
    if (inNativeShell) return
    if (stack.length > 1 && !historyPushed.current) {
      historyPushed.current = true
      try { window.history.pushState({ mobi: true }, '') } catch { /* 忽略 */ }
      return
    }
    // 用「‹」按钮/抽屉退回书架时，我们压的记录还在，主动退掉以免历史空转。
    // 硬件返回不会走到这里：那条记录已被 popstate 消费。
    if (stack.length <= 1 && historyPushed.current) {
      historyPushed.current = false
      try { window.history.back() } catch { /* 忽略 */ }
    }
  }, [stack.length])

  useEffect(() => {
    const onPop = () => {
      historyPushed.current = false // 这次返回消费掉了哨兵
      const r = onBackRequestRef.current()
      // 关浮层（层级未变）⇒ 补回哨兵，让返回键还能继续按；
      // 退了一层 ⇒ 上面的 effect 会按新深度自行补哨兵；到顶 ⇒ 交给浏览器。
      if (r === 'panel') {
        historyPushed.current = true
        try { window.history.pushState({ mobi: true }, '') } catch { /* 忽略 */ }
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  return (
    <>
      <Backdrop />
      <div className={`app${immersive ? ' app--immersive' : ''}`}>
        {immersive ? null : (
        <header className="topbar">
          {inProject ? (
            <button className="icon-btn topbar__menu" onClick={() => setNavOpen(true)} aria-label="作品导航" aria-expanded={navOpen}>
              ☰
            </button>
          ) : view !== 'shelf' ? (
            <button className="icon-btn" onClick={back} aria-label="返回">
              ‹
            </button>
          ) : null}
          <div className="topbar__title">
            {titles[view]}
            {view === 'outline' && project ? (
              <span className="topbar__sub">
                已写 {project.chapters?.length || 0}/{project.outline?.totalChapters || '—'} 章
              </span>
            ) : null}
          </div>
          {view === 'shelf' ? (
            <button className="icon-btn icon-btn--text" onClick={() => push('settings')}>
              设置
            </button>
          ) : null}
        </header>
        )}

        <main className={immersive ? 'page page--immersive' : 'page'}>
          {view === 'shelf' ? (
            <Shelf
              hasKey={config?.hasKey}
              onNew={() => push('create')}
              onOpen={openProject}
              onSettings={() => push('settings')}
            />
          ) : null}

          {view === 'create' ? (
            <Create
              onCreated={(p) => {
                setProject(p)
                setStack(['shelf', 'outline'])
                scrollTop()
              }}
            />
          ) : null}

          {view === 'outline' && project ? (
            <Outline
              project={project}
              setProject={setProject}
              onWrite={() => push('write')}
              onRead={(no) => {
                setReadingNo(no)
                push('read')
              }}
              onExport={() => setExportOpen(true)}
              onAssistant={openAssistant}
              onMaterials={() => navTo('materials')}
            />
          ) : null}

          {view === 'write' && project ? (
            <Write
              project={project}
              setProject={setProject}
              onRead={(no) => {
                setReadingNo(no)
                push('read')
              }}
              onExport={() => setExportOpen(true)}
            />
          ) : null}

          {view === 'read' && project ? (
            <Reader
              project={project}
              chapterNo={readingNo}
              onChangeNo={setReadingNo}
              onWriteNext={() => push('write')}
              onExport={() => setExportOpen(true)}
              onBack={back}
              guardRef={readerGuardRef}
            />
          ) : null}

          {view === 'direction' && project ? (
            <Direction project={project} setProject={setProject} />
          ) : null}

          {view === 'materials' && project ? (
            <CreationDrawer
              project={project}
              onApplied={setProject}
              onAssistant={(text) => openAssistant(text, '创作资料')}
            />
          ) : null}

          {view === 'assistant' && project ? (
            <Assistant
              project={project}
              context={assistantFrom}
              initialText={assistantText}
              onApplied={setProject}
            />
          ) : null}

          {view === 'settings' ? (
            <Settings
              config={config}
              onSaved={(c) => setConfig((prev) => ({ ...prev, ...c }))}
            />
          ) : null}
        </main>
      </div>
      {exportOpen && project ? (
        <ExportSheet project={project} onClose={() => setExportOpen(false)} />
      ) : null}
      <NavDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        project={project}
        view={view}
        onNav={navTo}
        onExport={() => setExportOpen(true)}
        onHome={home}
        onAssistant={openAssistant}
        onMaterials={() => navTo('materials')}
      />
      </>
  )
}
