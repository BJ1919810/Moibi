import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
// ⛔ 状态词汇**只有一份**，在服务端，而且**按问题选集合**：
//    ATTENTION = 「本章有没有任务要接手显示」（含等人处理的两个状态）
//    RUNNING   = 「机器还在自己往前走」（据此决定要不要继续轮询）
import { ATTENTION_RUN_STATUSES, RUNNING_RUN_STATUSES } from '../../server/run-status.js'

/**
 * 本界面只关注 run 状态，不在页面生命周期内持有实际模型请求。
 * 手机锁屏/切后台再回来时，根据 run_id 重新查询，不会重复生成正文。
 */
const ATTENTION = new Set(ATTENTION_RUN_STATUSES)
const STATES = { queued: '等待执行', planning: '准备上下文', writing: '撰写正文', reviewing: '保存草稿',
  extracting: '提取长期记忆', awaiting_acceptance: '待确认', needs_input: '需要处理',
  committed: '已正式提交', stale: '基线已过期', cancelled: '已取消', failed: '生成失败' }

export default function Write({ project, setProject, onRead, onExport }) {
  const [run, setRun] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  /** 编辑本章写作任务 —— 「概要审查」那条诊断的**真实出口**（此前这两个字段界面上改不了） */
  const [editingTask, setEditingTask] = useState(false)
  const [taskDraft, setTaskDraft] = useState({ summary: '', goal: '' })
  const [showContext, setShowContext] = useState(false)
  const [context, setContext] = useState(null)
  const chapters = project.chapters || []
  const total = project.outline?.totalChapters || 0
  const nextNo = chapters.length ? Math.max(...chapters.map((c) => c.no)) + 1 : 1
  const lastNo = chapters.length ? Math.max(...chapters.map((c) => c.no)) : 0
  const finished = total > 0 && nextNo > total
  const pct = total ? Math.round((chapters.length / total) * 100) : 0
  // 正文已写完且记忆已抽取，却停在 needs_input ⇒ 一定是提交门禁拒绝的，
  // 这时「恢复任务」必然重复同一次失败，不能当主按钮给用户点。
  const stuckAtCommit = run?.status === 'needs_input' && !!run.draft?.text && run.draft.extractOk === true
  const meta = useMemo(() => {
    for (const v of project.outline?.volumes || []) for (const c of v.chapters || []) {
      if (c.no === nextNo) return { ...c, volumeTitle: v.title }
    }
    return null
  }, [project, nextNo])

  // 页面重新进入时恢复未完成任务；只恢复显示，不未经用户允许重发不确定请求。
  useEffect(() => {
    let alive = true
    api.listRuns(project.id).then(({ runs }) => {
      if (!alive) return
      const latest = runs.find((r) => r.chapterNo === nextNo && ATTENTION.has(r.status))
      if (latest) setRun(latest)
    }).catch(() => {})
    return () => { alive = false }
  }, [project.id, nextNo])

  useEffect(() => {
    if (!run?.id || !RUNNING_RUN_STATUSES.includes(run.status)) return
    let alive = true
    const poll = async () => {
      try {
        const data = await api.getRun(run.id)
        if (!alive) return
        setRun(data.run)
        if (data.run.status === 'committed') {
          const { project: fresh } = await api.getProject(project.id)
          if (!alive) return
          setProject(fresh)
          onRead(data.run.chapterNo)
        }
      } catch (e) { if (alive) setErr(e.message) }
    }
    const timer = setInterval(poll, 1800)
    void poll()
    return () => { alive = false; clearInterval(timer) }
  }, [run?.id, run?.status, project.id, setProject, onRead])

  const act = async (name) => {
    setBusy(true); setErr('')
    try {
      let result
      if (name === 'new') result = await api.writeChapter(project.id, nextNo, project.headVersion || 0)
      if (name === 'resume') result = await api.resumeRun(run.id)
      if (name === 'cancel') result = await api.cancelRun(run.id)
      if (name === 'accept') result = await api.acceptRun(run.id)
      // 提交门禁拒绝后，草稿本身是完好的：直接再走一次 accept 即可免费落库。
      // 失败时后端的报错会指明「是哪一条、为什么」，原样展示给用户判断。
      if (name === 'submit') result = await api.acceptRun(run.id)
      if (name === 'regen') {
        // 提交门禁拒绝后无法恢复：先取消这条卡死的任务，再重新落笔同一章。
        await api.cancelRun(run.id)
        result = await api.writeChapter(project.id, nextNo, project.headVersion || 0)
      }
      setRun(result.run)
      if (result.run.status === 'committed') {
        const { project: fresh } = await api.getProject(project.id)
        setProject(fresh); onRead(result.run.chapterNo)
      }
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }
  const inspect = async () => {
    if (!run?.id) return
    try {
      const r = await api.getRunContext(run.id)
      setContext(r); setShowContext((v) => !v)
    } catch (e) { setErr(e.message) }
  }

  /**
   * 批准本章的写作任务（`chapter_task_approval`）。
   *
   * 为什么需要这个按钮：`writerSummary/writerGoal` 是作者**付过钱**的规划产物，但投影层要求
   * `writerTaskApproval==='author-approved'` 才把它们交给正文模型 —— 而在此之前全项目
   * **没有任何写入方** ⇒ 每写一章都会**多花一次 L2 调用**去现编安全任务，那笔规划费从没
   * 真正用在正文上。走的是与「创作资料与编辑」完全相同的 ChangeRequest 通道（CAS + 审计）。
   */
  const approveTask = async () => {
    setBusy(true); setErr(''); setNotice('')
    try {
      const { request } = await api.createChange(project.id, {
        kind: 'chapter_task_approval', chapterNo: nextNo,
        expectedHeadVersion: project.headVersion || 0,
        expectedEditRevision: project.editRevision || 0,
      })
      const result = await api.approveChange(request.id)
      setProject(result.project)
      setNotice(`已批准第 ${nextNo} 章的写作任务，下一章起正文就会用上这段（修订版本 ${result.project.editRevision}）。`)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  /** 打开编辑器：把当前任务读进草稿（不改库） */
  const startEditTask = () => {
    setTaskDraft({ summary: meta?.writerSummary || '', goal: meta?.writerGoal || '' })
    setEditingTask(true); setErr(''); setNotice('')
  }
  /**
   * 保存并批准本章写作任务。
   * 作者**亲手写**的就是批准 —— 这道门禁防的是「模型自报 author-approved」，不是防作者，
   * 所以一次提交即可，不必再点一次「批准」。
   */
  const saveTask = async () => {
    setBusy(true); setErr(''); setNotice('')
    try {
      const { request } = await api.createChange(project.id, {
        kind: 'chapter_task_text', chapterNo: nextNo,
        writerSummary: taskDraft.summary, writerGoal: taskDraft.goal,
        expectedHeadVersion: project.headVersion || 0,
        expectedEditRevision: project.editRevision || 0,
      })
      const result = await api.approveChange(request.id)
      setProject(result.project)
      setEditingTask(false)
      setNotice(`已保存并批准第 ${nextNo} 章的写作任务（修订版本 ${result.project.editRevision}）。`)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  if (project.pendingReplan && !run) return <div className="notice notice--err">作品设定已经修改，后续规划未完成。请返回目录，在“后续规划需要更新”处重排，再继续写作。</div>

  if (finished && !run) return <>
    <div className="empty">全书 {total} 章已完成。</div>
    <button className="btn btn--ghost btn--lg" onClick={() => onRead(lastNo)}>阅读最后一章</button>
    <div className="spacer" />
    <button className="btn btn--primary btn--lg" onClick={onExport}>导出全书</button>
  </>
  if (!meta && !run) return <div className="empty">大纲中没有第 {nextNo} 章，请先检查规划。</div>
  if (meta?.pendingDetail && !run) return <div className="notice notice--err">第 {nextNo} 章尚处于待细化的占位规划。请返回目录，点击「细化下一组（最多 5 章）」后再继续执笔。</div>

  return <>
    <div className="progress"><div className="progress__bar"><span style={{ width: `${pct}%` }} /></div>
      <div className="progress__text">已写 {chapters.length} 章 · 共 {total} 章</div></div>
    <div className="writer-head"><div className="writer-head__no">第 {run?.chapterNo || nextNo} 章</div>
      <div className="writer-head__title">{meta?.title || run?.draft?.title || '正在写作'}</div></div>
    {/* 未批准时**先把「将要交给正文模型的内容」摊开给作者看**，再让作者点头 ——
        否则就是盲签（旧版只显示一句占位文案，作者看不到自己在批准什么）。 */}
    {meta && editingTask ? (
      <div className="writer-head__goal">
        <div className="setting-note">直接改这一章交给正文模型的写作任务（上层「概要审查」报警时，就在这里把带真相措辞的说法改掉）。改完即视为你本人的批准。</div>
        <label className="edit-label">写作任务（表层）
          <textarea className="field" aria-label="写作任务" value={taskDraft.summary}
            onChange={(e) => setTaskDraft({ ...taskDraft, summary: e.target.value })}
            placeholder="这一章要发生什么（只写可观察的动作与场景，不含真相措辞）" />
        </label>
        <label className="edit-label" style={{ marginTop: 8 }}>本章目标（表层）
          <textarea className="field" aria-label="本章目标" value={taskDraft.goal}
            onChange={(e) => setTaskDraft({ ...taskDraft, goal: e.target.value })}
            placeholder="本章要达成的可观察变化" />
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setEditingTask(false)} disabled={busy}>取消</button>
          <button className="btn btn--primary btn--sm" onClick={saveTask}
            disabled={busy || (!taskDraft.summary.trim() && !taskDraft.goal.trim())}>保存并批准</button>
        </div>
      </div>
    ) : meta && (meta.writerTaskApproval === 'author-approved'
      ? <div className="writer-head__goal">{meta.writerSummary}</div>
      : (meta.writerSummary || meta.writerGoal) ? <div className="writer-head__goal">
          <div className="setting-note">本章的写作任务还没批准：正文只会拿到保守占位，而且每写一章都会多花一次 L2 调用去现编安全任务。下面这段就是批准后会交给正文模型的内容。</div>
          {meta.writerSummary ? <div>{meta.writerSummary}</div> : null}
          {meta.writerGoal ? <div className="setting-note">目标：{meta.writerGoal}</div> : null}
        </div>
        : <div className="writer-head__goal">本章按已授权计划继续故事。</div>)}
    {/* 任务相关的动作收在一处：批准 / 编辑（编辑是「概要审查」那条诊断的出口） */}
    {meta && !editingTask && (meta.writerSummary || meta.writerGoal) ? <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      {meta.writerTaskApproval !== 'author-approved'
        ? <button className="btn btn--ghost btn--sm" onClick={approveTask} disabled={busy}>批准本章写作任务</button> : null}
      <button className="btn btn--ghost btn--sm" onClick={startEditTask} disabled={busy}>编辑本章写作任务</button>
    </div> : null}
    {notice && <div className="notice" style={{ marginTop: 12 }}>{notice}</div>}
    {run && <div className="notice" style={{ marginTop: 16 }}>
      <strong>{STATES[run.status] || run.status}</strong> · {run.step}
      {run.cost && <div style={{ marginTop: 6 }}>累计 {run.cost.calls} 次请求 · 输入 {run.cost.inputTokens} / 输出 {run.cost.outputTokens} tokens
        {run.cost.estimatedCost != null ? ` · 估算费用 ${run.cost.estimatedCost.toFixed(5)}` : ' · 未设模型单价'}</div>}
      {run.error && <div style={{ marginTop: 8 }}>{run.error}</div>}
      {run.draft?.text && <details style={{ marginTop: 12 }}><summary>查看当前草稿（尚未必然定稿）</summary>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 340, overflow: 'auto' }}>{run.draft.text}</div></details>}
    </div>}
    {err && <div className="notice notice--err" style={{ marginTop: 16 }}>{err}</div>}
    <div className="spacer" />
    {chapters.length ? (
      <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
        <button className="btn btn--ghost btn--grow" onClick={() => onRead(lastNo)}>
          阅读已写章节（第 {lastNo} 章）
        </button>
        <button className="btn btn--ghost" onClick={onExport}>
          导出
        </button>
      </div>
    ) : null}
    {run ? <>
      {['needs_input','failed'].includes(run.status) && !stuckAtCommit && <button className="btn btn--primary btn--lg" onClick={() => act('resume')} disabled={busy}>恢复任务（可能重新请求未完成步骤）</button>}
      {stuckAtCommit && <div className="notice notice--err" style={{ marginTop: 8 }}>
        本章正文与记忆都已生成，提交被门禁拒绝，无法“恢复”重试（只会重复同一次失败）。
        你可以直接提交草稿（免费，失败会告诉你具体哪一条冲突），或重新生成。
        <div className="row" style={{ gap: 10, marginTop: 10, display: 'flex' }}>
          <button className="btn btn--primary btn--grow" onClick={() => act('submit')} disabled={busy}>直接提交本章草稿</button>
          <button className="btn btn--ghost" onClick={() => act('regen')} disabled={busy}>重新生成</button>
        </div>
        <div className="row" style={{ marginTop: 8, display: 'flex' }}>
          <button className="btn btn--ghost btn--grow" onClick={() => act('cancel')} disabled={busy}>取消本章任务</button>
        </div>
      </div>}
      {run.status === 'awaiting_acceptance' && <button className="btn btn--primary btn--lg" onClick={() => act('accept')} disabled={busy}>确认正文并提交记忆</button>}
      {ATTENTION.has(run.status) && <button className="btn btn--ghost btn--lg" style={{ marginTop: 8 }} onClick={() => act('cancel')} disabled={busy}>停止后续操作</button>}
      {run.manifest && <button className="btn btn--ghost btn--lg" style={{ marginTop: 8 }} onClick={inspect} disabled={busy}>{showContext ? '收起' : '查看'}本次上下文与版本来源</button>}
      {showContext && context && <details open style={{ marginTop: 10 }}><summary>编译结果</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{JSON.stringify(context.manifest, null, 2)}</pre>
        <details><summary>本次实际 WriterPacket（请勿分享含原稿的数据）</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{context.prompt}</pre></details>
      </details>}
    </> : <button className="btn btn--primary btn--lg" onClick={() => act('new')} disabled={busy}>落笔写这一章</button>}
  </>
}
