import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

/**
 * 「AI 助手」独立页面（从作品导航进入）。
 *
 * 为什么从浮层抽屉改成整页：
 *   它和「剧情方向修改」是同一类东西 —— **一个完整的作者操作入口**，
 *   不是盖在内容上的临时面板。做成右侧滑入的浮窗有两处硬伤：
 *     ① 头部被迫走「面板头」那套（旁边挂着 ✕），跟作品内其它页面的
 *        「☰ + 大标题」两栏结构对不上，点目录还会把整个面板关掉；
 *     ② 面板宽度只有 530px 且右贴边，手机上其实是「一页盖在半页上」，
 *        但用户心智里它就是「一页」。
 *   改成整页后：走全局顶栏（☰ + AI 助手），复用 .footer-actions 贴底操作条，
 *   与剧情方向修改页完全同构。
 *
 * 落库仍是同一条正规链路：POST /assistant/propose（模型只出 proposal）
 *   → 用户点「确认应用」→ replyAssistant 才真正改作品。
 * 不绕过任何门禁，也不直接编辑已定稿正文或账本。
 */
export default function Assistant({ project, context = '作品', initialText = '', onApplied }) {
  const [text, setText] = useState(initialText)
  const [proposal, setProposal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 从「创作资料」里点「让 AI 分析」进来时，会把要问的话带过来
  useEffect(() => { setText(initialText) }, [initialText, project?.id])

  const submit = async () => {
    if (!project?.id || !text.trim() || busy) return
    setBusy(true); setError(''); setProposal(null)
    try {
      const { run } = await api.proposeProject(project.id, { instruction: `当前页面：${context}。${text.trim()}` })
      setProposal(run)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const answer = async (accepted) => {
    if (!proposal) return
    setBusy(true); setError('')
    try {
      const result = await api.replyAssistant(proposal.id, accepted ? '同意' : '取消')
      setProposal(null)
      if (result.project) onApplied?.(result.project)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return <>
    <p className="setting-note">
      当前上下文：{context} · {project?.title || '未选择作品'}。
      AI 只能提出有限变更建议，不会直接编辑已定稿正文或账本 ——
      拿到建议后由你点「确认应用」才会真正落到作品上。
    </p>

    <label className="edit-label edit-label--grow draft-grow">
      <span className="sr-only">要对 AI 说的话</span>
      <textarea className="field" value={text} disabled={!!proposal}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：让文风更克制；修改某位角色的姓名；把第三章的转折再往后压一章" />
    </label>

    {proposal ? <div className="change-preview">
      <strong>待确认 · 尚未修改作品</strong>
      {/*
        「将要改什么」由**程序**在副本上试算得出（服务端 previewChangeDiff），
        不再靠模型自述 —— 主人反馈过：模型那句 summary 常常只说「调整了文风」这类模糊话，
        分不清是规则层允许的内容还是它的原生回答。答案：summary 是原生回答，只有 change 过了白名单。
      */}
      {(proposal.diff || []).length ? <div className="diff-list">
        <div className="diff-list__title">将要改动 {proposal.diff.length} 处</div>
        {proposal.diff.map((d, i) => (
          <div className="diff-row" key={i}>
            <span className="diff-row__label">{d.label}</span>
            <span className="diff-row__old">{d.before || '（空）'}</span>
            <span className="diff-row__arrow">→</span>
            <span className="diff-row__new">{d.after || '（空）'}</span>
          </div>
        ))}
      </div> : <p className="setting-note">这次建议没有产生可识别的字段改动（可能是空提议）。</p>}
      <p className="setting-note">修改类型：{proposal.change?.kind} · 助手自述：{proposal.summary}</p>
    </div> : null}

    {error ? <div role="alert" className="notice notice--err">{error}</div> : null}

    {/* 与剧情方向修改页同一套贴底操作条 */}
    <div className="footer-actions">
      {proposal ? <>
        <button className="btn btn--ghost" disabled={busy} onClick={() => answer(false)}>取消</button>
        <button className="btn btn--primary btn--grow" disabled={busy} onClick={() => answer(true)}>
          {busy ? '应用中…' : '确认应用'}
        </button>
      </> : <button className="btn btn--primary btn--grow"
        disabled={busy || !project?.id || !text.trim()} onClick={submit}>
        {busy ? '请求中…' : '生成建议'}
      </button>}
    </div>
  </>
}
