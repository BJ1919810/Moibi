import { useState } from 'react'
import { api } from '../lib/api.js'

/**
 * 「剧情方向修改」独立页面。
 *
 * 为什么单独成页而不塞进「创作资料与编辑」抽屉：
 *   它是一个**纯主观的作者意图入口** —— 用户在这里写「接下来我想往哪走」，
 *   内容本身不追求结构严谨，也不由模型生成，只作为重排（replan）时的作者意图输入。
 *   与抽屉里那些「对照既有字段做定向修改」的操作性质不同，混在一起反而不好找。
 *
 * 落库仍是同一条正规链路：POST /changes（kind=plot_direction）→ 预览影响 → 确认提交。
 * 不绕过任何门禁，也不直接改作品。
 */
export default function Direction({ project, setProject }) {
  const [draft, setDraft] = useState(project.authorPlotDirection || '')
  const [request, setRequest] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const source = project.authorPlotDirection || ''

  const preview = async () => {
    setBusy(true); setErr(''); setNotice('')
    try {
      const { request: r } = await api.createChange(project.id, {
        kind: 'plot_direction',
        value: draft,
        expectedHeadVersion: project.headVersion || 0,
        expectedEditRevision: project.editRevision || 0,
      })
      setRequest(r)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true); setErr('')
    try {
      const result = await api.approveChange(request.id)
      setProject(result.project)
      setRequest(null)
      setNotice('已提交，修订版本 ' + result.project.editRevision
        + (result.project.pendingReplan ? '；请在目录完成未写章节重排。' : ''))
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const reject = async () => {
    setBusy(true)
    try { await api.rejectChange(request.id); setRequest(null) }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return <>
    <div className="section-title">剧情方向</div>
    <p className="setting-note">
      写下你希望故事接下来往哪走 —— 想看到的情节、想强化的矛盾、想避开的方向。
      这段内容是<strong>你的主观意图</strong>，不会由 AI 代写；重排未写章节时模型会把它当作强约束。
      已定稿正文不会被改动。
    </p>
    <textarea className="field field--area" rows={9} value={draft} disabled={!!request}
      onChange={(e) => { setDraft(e.target.value); setNotice('') }}
      placeholder="例如：接下来三章压住感情线，先让主角查出父亲的旧案；不要过早引入超自然元素，反派要显得有道理。" />

    {err ? <div role="alert" className="notice notice--err">{err}</div> : null}
    {notice ? <div className="notice">{notice}</div> : null}

    {request ? <div className="change-preview">
      <strong>待确认修改 · {request.impact.risk === 'high' ? '高风险' : request.impact.risk === 'medium' ? '中风险' : '低风险'}</strong>
      <p>{request.impact.warning}</p>
      <p>影响章节：{request.impact.affectedChapters?.slice(0, 30).join('、') || '未检测到规划引用'}（含已写关联 {request.impact.committedChapterCount} 条）</p>
      <p className="setting-note">确认前不会修改正式作品。</p>
    </div> : null}

    <div className="footer-actions">
      {request ? <>
        <button className="btn btn--ghost" disabled={busy} onClick={reject}>取消</button>
        <button className="btn btn--primary btn--grow" disabled={busy} onClick={confirm}>{busy ? '提交中…' : '确认并提交'}</button>
      </> : <button className="btn btn--primary btn--grow" disabled={busy || !String(draft).trim() || String(source) === String(draft)}
        onClick={preview}>{busy ? '分析中…' : '预览影响'}</button>}
    </div>
  </>
}
