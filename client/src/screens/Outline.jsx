import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
// 重排任务的状态词汇只在服务端定义一份（见 server/run-status.js 里为什么按问题命名）
import { RUNNING_REPLAN_STATUSES } from '../../server/run-status.js'

/** 默认展示可阅读目录；作者设定藏于独立抽屉。 */
export default function Outline({project,setProject,onWrite,onRead,onExport,onAssistant,onMaterials}) {
  const [busy,setBusy]=useState(false)
  const [err,setErr]=useState('')
  const [replanRun,setReplanRun]=useState(null)
  const [showAudit,setShowAudit]=useState(false)
  const o=project.outline||{}
  const chapters=project.chapters||[]
  const doneNos=new Set(chapters.filter(c=>c.status==='committed').map(c=>c.no))
  const hasPendingDetail=(o.volumes||[]).some(v=>(v.chapters||[]).some(c=>c.pendingDetail))

  /* 概要审查诊断：后端在落盘时算出「哪一章的表层概要可能抄了伏笔的回收真相」。
     这里只**呈现**，不改任何数据 —— 判据本身有边界命中，交由作者判断。 */
  const audit=Array.isArray(o.summaryAudit)?o.summaryAudit:[]
  const auditNotes=Array.isArray(project.outlineNotes)?project.outlineNotes:[]
  const auditNos=new Set(audit.map(a=>a.chapterNo))
  /* 章节投影诊断：本章生成时做过哪些隔离/剔除（如出场名单缺失退化为只允许主角）。
     这是刚接通的一条旧线 —— 后端 collectContextNotes 一直在写，界面此前从未读过。 */
  const contextNotesOf=(no)=>{const c=chapters.find(x=>x.no===no);return (c&&Array.isArray(c.contextNotes))?c.contextNotes:[]}
  useEffect(()=>{
    if(!replanRun?.id||!RUNNING_REPLAN_STATUSES.includes(replanRun.status)) return
    let alive=true
    const poll=async()=>{try {const {run}=await api.getRun(replanRun.id);if (!alive) return;setReplanRun(run);if(run.status==='committed'){const {project:fresh}=await api.getProject(project.id);if(alive)setProject(fresh)}}catch(e){if(alive)setErr(e.message)}}
    const timer=setInterval(poll,2000);void poll()
    return ()=>{alive=false;clearInterval(timer)}
  },[replanRun?.id,replanRun?.status,project.id,setProject])
  const doReplan=async()=>{
    if(!window.confirm('将使用模型重新规划尚未定稿的章节，可能产生 API 费用。已定稿正文不修改。继续？')) return
    setBusy(true);setErr('')
    try {const {run}=await api.replanFuture(project.id);setReplanRun(run)}catch(e){setErr(e.message)}finally{setBusy(false)}
  }
  const retryReplan=async()=>{setBusy(true);try {const {run}=await api.resumeRun(replanRun.id);setReplanRun(run)}catch(e){setErr(e.message)}finally{setBusy(false)}}
  const detailWindow=async()=>{
    if (!window.confirm('使用模型细化下一组最多 5 章，不修改已定稿正文。可能产生 API 费用。继续？')) return
    setBusy(true);setErr('')
    try {const {run}=await api.replanFuture(project.id,'window');setReplanRun(run)}catch(e){setErr(e.message)}finally{setBusy(false)}
  }

  const retryOutline=async()=>{
    if (doneNos.size) return setErr('已有定稿正文，不允许整体重建大纲')
    if (o.volumes?.length && !window.confirm('重新生成将替换尚未定稿的大纲和相关角色设定，可能产生模型费用。继续？')) return
    setErr('');setBusy(true)
    try {const {project:fresh}=await api.regenerateOutline(project.id,{});setProject(fresh)}
    catch(e){setErr(e.message)}finally{setBusy(false)}
  }
  if(!o.volumes?.length) return <>
    <div className="empty" role="status">大纲尚未生成成功。{project.outlineError ? `上次错误：${project.outlineError}` : '请检查密钥与模型配置。'}失败的作品已保存，可重新生成。</div>
    {err?<div role="alert" className="notice notice--err">{err}</div>:null}
    <button className="btn btn--primary btn--lg" onClick={retryOutline} disabled={busy}>{busy?'正在重新构思…':'重新生成大纲'}</button>
  </>
  return <>
    <div className="outline-head"><h1 className="outline-head__title">{project.title||o.title}</h1><div className="outline-head__logline">{o.publicLoglineApproved?o.readerLogline:(o.logline||'故事目录')}</div>
      <div className="meta-row"><span className="meta-pill">已定稿 {doneNos.size} 章</span><span className="meta-pill">目标 {o.totalChapters||project.targetChapters||'—'} 章</span></div>
    </div>
    <div className="editor-actions editor-actions--top"><button className="btn btn--ghost" onClick={()=>onMaterials?.()}>创作资料与编辑</button><button className="btn btn--ghost" onClick={()=>onAssistant?.('请结合这部作品提供定向建议，不要自动修改资料。')}>AI 助手</button>{!doneNos.size&&!project.pendingReplan?<button className="btn btn--ghost" disabled={busy} onClick={retryOutline}>{busy?'重新构思中…':'重新构思大纲'}</button>:null}</div>
    {project.pendingReplan ? <div className="notice notice--err" role="status"><strong>后续规划需要更新</strong><p>作者设定发生结构性变化。为避免旧大纲产生冲突，后续正文已暂停生成。</p>
      <button className="btn btn--primary btn--sm" disabled={busy||RUNNING_REPLAN_STATUSES.includes(replanRun?.status)} onClick={doReplan}>重排尚未定稿章节（调用模型）</button>
      {replanRun?<p>重排任务：{replanRun.status} · {replanRun.step}{replanRun.error?` · ${replanRun.error}`:''}</p>:null}
      {['needs_input','failed'].includes(replanRun?.status)?<button className="btn btn--ghost btn--sm" onClick={retryReplan}>恢复重排</button>:null}</div>:null}
    {!project.pendingReplan&&hasPendingDetail?<div className="notice" role="status">其余章节目前只有占位目录。写到新窗口前需要细化，防止角色与剧情由不完整计划直接生成。
      <button className="btn btn--ghost btn--sm" onClick={detailWindow} disabled={busy||RUNNING_REPLAN_STATUSES.includes(replanRun?.status)}>细化下一组（最多 5 章）</button>
      {replanRun?<p>规划任务：{replanRun.status} · {replanRun.step}{replanRun.error?` · ${replanRun.error}`:''}</p>:null}
      {['needs_input','failed'].includes(replanRun?.status)?<button className="btn btn--ghost btn--sm" onClick={retryReplan} disabled={busy}>恢复规划</button>:null}</div>:null}
    {(audit.length||auditNotes.length)?<div className="notice notice--warn" role="status">
      <strong>概要审查：{audit.length} 章可能把回收真相写进了表层概要</strong>
      <p>这些章节的概要已保留原样（不自动改写、不阻断生成）。要修正就去「执笔页 → 本章写作任务 → 编辑」改掉带真相措辞的说法；若只是措辞巧合，可以不动。</p>
      <button className="btn btn--ghost btn--sm" onClick={()=>setShowAudit(v=>!v)}>{showAudit?'收起明细':'查看明细'}</button>
      {showAudit?<ul className="audit-list">{auditNotes.map((n,i)=><li key={i}>{n}</li>)}</ul>:null}
    </div>:null}
    {err?<div role="alert" className="notice notice--err">{err}</div>:null}
    <div className="section-title">章节目录</div>
    {o.volumes.map((v,i)=><section className="volume" key={`${v.title}-${i}`}><div className="volume__head"><b className="volume__name">{v.title}</b></div>
      {v.goal?<div className="volume__goal">{v.goal}</div>:null}
      {(v.chapters||[]).map(c=><div key={c.no} className={`chapter-row${doneNos.has(c.no)?' chapter-row--done chapter-row--link':''}`}
        onClick={doneNos.has(c.no)?()=>onRead(c.no):undefined} role={doneNos.has(c.no)?'button':undefined} tabIndex={doneNos.has(c.no)?0:undefined}
        onKeyDown={doneNos.has(c.no)?e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onRead(c.no)}}:undefined}>
        <span className="chapter-row__no">{c.no}</span><span><div className="chapter-row__title">{c.title||`第${c.no}章`}</div><div className="chapter-row__sum">{doneNos.has(c.no)?'已定稿 · 点击阅读':(c.summary||'尚待滚动规划')}</div>
          {!doneNos.has(c.no)&&auditNos.has(c.no)?<div className="chapter-row__flags"><span className="flag flag--warn" title="表层概要可能含回收真相">概要需复核</span></div>:null}
          {doneNos.has(c.no)&&contextNotesOf(c.no).length?<div className="chapter-row__flags">{contextNotesOf(c.no).map((n,k)=><span key={k} className="flag flag--note" title={n}>{n}</span>)}</div>:null}
        </span>
        {doneNos.has(c.no)?<span aria-hidden="true" className="chapter-row__go">›</span>:null}
      </div>)}
    </section>)}
    <div className="footer-actions">{chapters.length?<button className="btn btn--ghost" onClick={onExport}>导出</button>:null}
      <button className="btn btn--primary btn--grow" onClick={onWrite} disabled={!!project.pendingReplan}>{chapters.length?'继续执笔':'开始执笔'}</button></div>
  </>
}
