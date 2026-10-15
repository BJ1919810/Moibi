import { useState } from 'react'
import { api } from '../lib/api.js'

/**
 * A3：统一「输入框 + 提交」助手。
 * 模型永远只交付 proposal；只有用户点击确认，才通过服务端 ChangeRequest / CAS 应用。
 * 自由回复不能直接转换为数据库命令，也不允许修改正文。
 */
export default function AssistantBox({ project = null, draft = null, onApply, requestRef = null }) {
  const [text, setText] = useState('')
  const [proposal, setProposal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (instruction = null) => {
    const message = (instruction ?? text).trim()
    if (!message || busy) return
    setBusy(true); setError(''); setProposal(null)
    try {
      const { run } = project
        ? await api.proposeProject(project.id, { instruction: message })
        : await api.proposeCreate({...(draft || {}), instruction:message})
      setProposal(run)
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  // 创建页也走同一个提议通道，不会暗中应用结果。
  if (requestRef) requestRef.current = submit

  const confirm = async (accepted) => {
    if (!proposal) return
    setBusy(true);setError('')
    try {
      const result = await api.replyAssistant(proposal.id,accepted ? '同意' : '取消')
      setProposal(null)
      if (result.run.status === 'accepted') onApply?.(result)
    } catch (err) {setError(err.message)}
    finally {setBusy(false)}
  }
  return <section className="assistant-panel">
    <div className="section-title">AI 助手 <span className="section-hint">提供建议，确认后才修改作品</span></div>
    <textarea className="field" rows={2} value={text} onChange={(e)=>setText(e.target.value)}
      placeholder={project ? '例如：让文风更克制；把某个人物改名；微调未写章节标题' : '例如：给我一个现实悬疑故事的冷峻文风'} />
    <button className="btn btn--ghost" type="button" disabled={busy || !text.trim()} onClick={()=>submit()}>
      {busy ? '正在提议…' : '提交给 AI 助手'}
    </button>
    {proposal && <div className="assistant-proposal">
      <div className="assistant-proposal__tag">待确认 · 尚未修改作品</div>
      <p>{proposal.summary}</p>
      <div className="editor-actions"><button className="btn btn--ghost" disabled={busy} type="button" onClick={()=>confirm(false)}>取消</button><button className="btn btn--primary" disabled={busy} type="button" onClick={()=>confirm(true)}>确认应用</button></div>
    </div>}
    {error && <div className="notice notice--err">{error}</div>}
  </section>
}
