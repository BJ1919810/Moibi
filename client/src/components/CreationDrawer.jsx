import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const TABS = [{id:'theme',label:'主题'},{id:'act',label:'三幕'},{id:'character',label:'角色卡'},
  {id:'world',label:'世界观'},{id:'foreshadow',label:'伏笔'},{id:'settings',label:'设置'}]

/**
 * 「关系补充」在角色卡里存的是结构化数组 [{name,relation,note}]。
 * 直接塞进 textarea 会被 JS 转成 "[object Object],[object Object]"（旧 bug）。
 * 这里做双向转换：数组 ↔ 每行一条「名字 | 关系 | 备注」的可读文本。
 * 服务端在 applyChange 里按同一格式解析回数组。
 */
export const REL_SEP = '|'
export function relationsToText(list) {
  if (!Array.isArray(list)) return ''
  return list
    .map((r) => [r?.name, r?.relation, r?.note].map((x) => String(x ?? '').trim()).join(` ${REL_SEP} `))
    .filter((line) => line.replace(/[|\s]/g, ''))
    .join('\n')
}

/**
 * 创作资料与编辑。
 *
 * ⚠️ 它**不再是一个右侧滑入的浮层抽屉**（组件名沿用历史，见文件末尾的说明）：
 *   主人明确指出「你压根没想到改容器样式，还是浮窗格式，而且依旧有 X 号，
 *   我点目录自动退出这个界面了」。这条通路和其它作品内页面（剧情方向修改）
 *   本就同构 —— 都是完整的作者操作入口 —— 所以改成**整页**：
 *   走全局顶栏（☰ + 标题），复用 .editor-tabs / .editor-body / .footer-actions，
 *   点目录由全局顶栏开导航抽屉，不会再把这一页关掉。
 *
 * 只读源数据，所有输入保存在本地草稿；只有服务端返回可确认的 CR 才能提交。
 */
export default function CreationDrawer({project,onApplied,onAssistant}) {
  const [tab,setTab]=useState('theme')
  const [index,setIndex]=useState(0)
  const [field,setField]=useState('personality')
  const [draft,setDraft]=useState('')
  const [request,setRequest]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  // 两个「批准」入口各需要一个数字输入：伏笔关联的埋/收章、角色秘密的披露起始章
  const [linkPlantNo,setLinkPlantNo]=useState('')
  const [linkPayoffNo,setLinkPayoffNo]=useState('')
  const [revealChapterNo,setRevealChapterNo]=useState('')
  /**
   * 「查看上个版本」：**只是视图切换，绝不写库** —— 切过去看到的是只读旧值，
   * 切回来还是当前值；不切回来直接离开也不影响存储层。
   */
  const [showOld,setShowOld]=useState(false)
  const o=project.outline || {}
  const chars=project.entities || []
  const acts=o.acts || []
  const fs=o.foreshadows || []
  /** 上一次提交到底改了什么 —— 由服务端**程序**算出（`change-request.describeChange`），不靠模型自述 */
  const lastEdit=(project.editEvents||[]).slice(-1)[0]||null
  const lastDiff=lastEdit?.diff||[]
  /** 当前编辑的字段是否就在上次改动里 —— 有就标 🔴，并允许「查看上个版本」 */
  const diffForCurrent=lastDiff.find(d=>d.field===field)||null
  /**
   * 「查看上个版本」**只对文本框有意义**：结构化字段（埋/收章、披露起始章、章节目标）
   * 的旧值是个数字或占位，塞进文本框里没有意义 ⇒ 那类只标 🔴，不给切换。
   * 新增伏笔是「从无到有」，也没有可看的旧值。
   */
  const NO_OLD_VIEW=['add','link','reveal','target_chapters']
  const canShowOld=!!diffForCurrent&&!NO_OLD_VIEW.includes(field)
  const source=()=>{
    if(tab==='theme') return o.theme || ''
    if(tab==='world') return project.authorWorldRules || ''
    if(tab==='direction') return project.authorPlotDirection || ''
    if(tab==='act') return acts[index]?.summary || ''
    // 公开简介/主题：作者侧的那两份（logline/theme）永不进正文，只有这两份公开版会被送进去
    if(tab==='settings'&&field==='readerLogline') return o.readerLogline || ''
    if(tab==='settings'&&field==='readerTheme') return o.readerTheme || ''
    if(tab==='foreshadow') return field==='add' ? '' : field==='safeReveal' ? (fs[index]?.safeReveal?.text || '') : (fs[index]?.[field==='seed'?'seed':'payoff'] || '')
    if(tab==='settings') return field==='target_chapters' ? String(project.targetChapters || o.totalChapters || 30) : (project.preferences?.[field] || '')
    if(tab==='character') {
      const person=chars[index]
      if (!person) return ''
      if(field==='rename') return person.name || ''
      if(field==='publicIdentity' || field==='secret') return person[field] || ''
      // 关系是数组，必须先转成可读文本，否则显示 [object Object]
      if(field==='relationships') return relationsToText(person.characterCard?.relationships)
      return person.characterCard?.[field] || ''
    }
    return ''
  }
  // ⚠️ 提示语**不能**挂在 `project.editRevision` 上清：提交成功后 `onApplied()` 会让
  //    editRevision +1，那条 effect 随即把刚 setNotice 的「已提交，修订版本 N」以及
  //    高风险修改后的「请在目录完成未写章节重排」一起抹掉 —— 实测（真 Edge + CDP）
  //    UI 上永远看不到成功提示。改为按「用户切换了标签/对象/字段」来清。
  useEffect(()=>{ setNotice('') },[tab,index,field])
  useEffect(()=>{ setDraft(source());setRequest(null);setError('') },[project.id,project.editRevision,tab,index,field])
  // 数字输入要跟着「当前选中的伏笔/角色」初始化：一进面板就是空的，用户会以为必填
  useEffect(()=>{
    const f=fs[index]
    setLinkPlantNo(f?.plantChapter!=null?String(f.plantChapter):'')
    setLinkPayoffNo(f?.payoffChapter!=null?String(f.payoffChapter):'')
    // 披露默认「从下一章起」——与目录页/写作页「下一章 = 已定稿章数 + 1」同一口径
    setRevealChapterNo(String(Number(project.headVersion||0)+1))
  },[project.id,project.editRevision,tab,index])
  useEffect(()=>{ setShowOld(false) },[tab,index,field,project.editRevision])
  const switchTab=(value)=>{setTab(value);setIndex(0);setField(value==='character'?'personality':value==='foreshadow'?'seed':value==='settings'?'styleSpec':'')}
  const changePayload=()=>{
    const data={value:draft,expectedHeadVersion:project.headVersion||0,expectedEditRevision:project.editRevision||0}
    // 公开简介 / 公开主题：提交即视为**你本人批准**（清空提交 = 撤回公开，正文退回中性占位）
    if(tab==='settings'&&(field==='readerLogline'||field==='readerTheme')) {
      return {...data,kind:'reader_intro',field:field==='readerTheme'?'theme':'logline',value:draft}
    }
    // 新增伏笔：文本框里两行（第一行线索铺设／第二行作者侧回收真相），
    // 与「关系补充」同一套「每行一条」的约定（不给同一件事发明第二套输入方式）
    if(tab==='foreshadow'&&field==='add') {
      const lines=String(draft).split('\n').map(s=>s.trim()).filter(Boolean)
      return {...data,kind:'foreshadow_add',seed:lines[0]||'',payoff:lines.slice(1).join('\n')||''}
    }
    // 「批准」类不走 value 文本，各自带自己的字段（章号）
    if(tab==='foreshadow'&&field==='link') return {...data,kind:'foreshadow_link',foreshadowId:fs[index]?.id,
      plantChapter:linkPlantNo===''?null:Number(linkPlantNo),payoffChapter:linkPayoffNo===''?null:Number(linkPayoffNo)}
    if(tab==='character'&&field==='reveal') return {...data,kind:'entity_reveal_projection',entityId:chars[index]?.id,chapterNo:Number(revealChapterNo)}
    if(tab==='character') return {...data,kind:field==='rename'?'rename':'character_field',entityId:chars[index]?.id,...(field==='rename'?{}:{field})}
    if(tab==='act') return {...data,kind:'act',actIndex:index}
    if(tab==='foreshadow') return {...data,kind:'foreshadow',foreshadowId:fs[index]?.id,field}
    if(tab==='settings') return {...data,kind:field==='target_chapters'?'target_chapters':'preferences',...(field==='target_chapters'?{}:{field})}
    return {...data,kind:tab==='world'?'world':tab==='direction'?'plot_direction':'theme'}
  }
  /** 删除当前伏笔（已真实铺设/回收过的会被服务端拒绝，错误原样展示） */
  const removeForeshadow=async()=>{
    const f=fs[index]; if(!f) return
    if(!window.confirm(`删除伏笔「${String(f.seed||'').slice(0,20)}」？\n章节计划里的引用会一并清掉；已经在正文里出现过的伏笔不能删。`)) return
    setBusy(true);setError('');setNotice('')
    try {
      const {request}=await api.createChange(project.id,{kind:'foreshadow_remove',foreshadowId:f.id,
        expectedHeadVersion:project.headVersion||0,expectedEditRevision:project.editRevision||0})
      const result=await api.approveChange(request.id)
      onApplied(result.project); setIndex(0)
      setNotice('已删除该伏笔（章节计划里的引用也已清掉）。')
    } catch(e){setError(e.message)} finally{setBusy(false)}
  }
  const preview=async()=>{
    setBusy(true);setError('');setNotice('')
    try {const {request:r}=await api.createChange(project.id,changePayload());setRequest(r)}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const confirm=async()=>{
    setBusy(true);setError('')
    try {const result=await api.approveChange(request.id);onApplied(result.project);setRequest(null);setNotice('已提交，修订版本 '+result.project.editRevision+(result.project.pendingReplan?'；请在目录完成未写章节重排。':''))}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const reject=async()=>{
    setBusy(true);try {await api.rejectChange(request.id);setRequest(null)}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  // 设置页只保留「文风设定」一个合并字段：style/tone/pace 三者本就重叠，
  // 分开填既重复又容易互相矛盾（旧字段仍可读取历史数据，见 author-control.js）。
  const options={
    character:[['rename','角色名字'],['publicIdentity','公开身份'],['personality','性格'],['appearance','外貌'],['motivation','动机'],['arc','人物弧线'],['relationships','关系补充'],['secret','作者侧秘密'],['reveal','披露授权（秘密→读者）']],
    foreshadow:[['seed','线索铺设'],['payoff','作者侧回收真相'],['safeReveal','回收披露授权'],['link','伏笔关联章号（埋/收）'],['add','新增伏笔']],
    settings:[['styleSpec','文风设定'],['coreGoal','核心目标'],['forbidden','禁止描写'],['ending','结局偏好'],['target_chapters','章节目标'],['readerLogline','读者简介（公开）'],['readerTheme','读者可见主题（公开）']]
  }
  // 草稿区上方那行小标题：**只有「全宽 + 长文本」的字段才需要它**。
  // 其余字段（角色卡各属性、三幕、伏笔、设置各项）改的是什么，
  // 上面「修改内容」下拉已经写清楚了，再顶一个同样的标题就是重复。
  // 章节目标尤其明显：以前是「章节目标」+ 一个半屏大空框里孤零零一个 73。
  const fieldLabel = tab==='character' ? (options.character.find(x=>x[0]===field)?.[1]||'')
    : tab==='foreshadow' ? (options.foreshadow.find(x=>x[0]===field)?.[1]||'')
    : tab==='settings' ? (options.settings.find(x=>x[0]===field)?.[1]||'') : ''
  const draftLabel = tab==='theme' ? '主题'
    : tab==='world' ? '世界观规则'
    : tab==='character'&&field==='relationships' ? '关系补充'
    : tab==='character'&&field==='reveal' ? '可以对读者说出的版本'
    : tab==='settings'&&field==='styleSpec' ? '文风设定'
    : tab==='foreshadow'&&field==='add' ? '新增伏笔'
    : ''
  /** 三维条件：正在看上个版本时，草稿框只读、也不能提交（纯视图，不碰存储层） */
  /** 能不能提交：每种「批准」类入口的必填项不同 */
  const canSubmit=()=>{
    // 公开简介/主题：清空提交 = 撤回公开（那时草稿为空，但确实是一次有效改动）
    if(tab==='settings'&&(field==='readerLogline'||field==='readerTheme')) return String(draft).trim()!=='' || String(source()).trim()!==''
    if(tab==='foreshadow'&&field==='add') return String(draft).split('\n').map(s=>s.trim()).filter(Boolean).length>=2
    if(tab==='foreshadow'&&field==='link') return String(linkPlantNo).trim()!=='' || String(linkPayoffNo).trim()!==''
    if(tab==='character'&&field==='reveal') return String(draft).trim()!=='' && String(revealChapterNo).trim()!==''
    // safeReveal：清空即撤回（这时草稿为空但确实是一次有效改动）
    if(tab==='foreshadow'&&field==='safeReveal') return String(draft).trim()!=='' || !!fs[index]?.safeReveal
    return String(draft).trim()!==''
  }
  /** 有没有真的改动 —— 避免「预览影响」点了却什么都没变 */
  const changed=()=>{
    if(tab==='foreshadow'&&field==='add') return String(draft).trim()!==''
    if(tab==='foreshadow'&&field==='link') return String(linkPlantNo)!==String(fs[index]?.plantChapter??'') || String(linkPayoffNo)!==String(fs[index]?.payoffChapter??'')
    if(tab==='character'&&field==='reveal') return true
    return String(source())!==String(draft)
  }
  return <>
      <div className="editor-tabs">{TABS.map(t=><button type="button" key={t.id} onClick={()=>switchTab(t.id)} className={tab===t.id?'editor-tab editor-tab--active':'editor-tab'}>{t.label}</button>)}</div>
      <div className="editor-body">
        <p className="setting-note">作者侧设定仅用于规划。已定稿正文不会自动覆盖；高风险修改先冻结后续章节并要求重排。改动走「预览影响 → 确认提交」，预览前不会动正式作品。</p>
        {tab==='act'&&o.volumeMilestones?.length?<div className="setting-note"><b>全书分卷里程碑（作者侧）</b>
          {o.volumeMilestones.map((v,i)=><p key={i}>{v.title}：{v.goal||'待完善'}</p>)}
        </div>:null}
        {/* 「选择对象 / 修改内容」并排成一行，省掉两层竖向堆叠 */}
        {(tab==='character'||tab==='act'||tab==='foreshadow') || options[tab] ? <div className="edit-grid">
          {tab==='character'||tab==='act'||tab==='foreshadow' ? <label className="edit-label">选择对象
            <select className="field" value={index} onChange={e=>{setIndex(Number(e.target.value));setRequest(null)}}>
              {(tab==='character'?chars:tab==='act'?acts:fs).map((x,i)=><option key={x.id||x.name||i} value={i}>{tab==='character'?x.name:tab==='act'?x.name||`第${i+1}幕`:String(x.seed||'未命名伏笔').slice(0,45)}</option>)}
            </select>
          </label> : null}
          {options[tab] ? <label className="edit-label">修改内容{diffForCurrent ? ' 🔴' : ''}
            <select className="field" value={field} onChange={e=>{setField(e.target.value);setRequest(null)}}>{options[tab].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
          </label> : null}
        </div> : null}
        {/* 草稿区上方保留一行「在改哪一项」—— 只在长文本字段显示（见 draftLabel 注释）。
            以「修改内容」下拉当前选中的那一项命名，不再一律写「编辑草稿」：
            标题和它下面真正在编辑的字段对得上，才不会看错栏。 */}
        {draftLabel ? <div className="draft-head">
          <span className="draft-head__label">{draftLabel}</span>
          {tab==='character'&&field==='relationships' ? <span className="draft-head__hint">每行一条：名字 | 关系 | 备注</span> : null}
          {tab==='foreshadow'&&field==='add' ? <span className="draft-head__hint">第一行：线索铺设（表层）；第二行：作者侧回收真相</span> : null}
        </div> : null}
        {/* 「上个版本」开关**独立成一行**：短字段（性格/外貌…）没有 draft-head
            （早先的设计决定：短字段的标题由「修改内容」下拉给出），
            而 🔴 与这个开关恰恰最需要在那些字段上出现。 */}
        {canShowOld ? <div className="draft-head">
          <span className="draft-head__hint">{showOld ? '正在看上个版本（只读，不改动作品）' : '这一项在上次改动里被改过'}</span>
          <button type="button" className="link-btn" onClick={()=>setShowOld(v=>!v)}>{showOld?'回到当前版本':'查看上个版本'}</button>
        </div> : null}
        {tab==='settings'&&field==='target_chapters' ? (
          <div className="field-row">
            <span className="field-row__label">{fieldLabel}</span>
            <input className="field field--num" type="number" min="1" max="999" value={draft}
              aria-label={fieldLabel||'章节目标'}
              onChange={e=>{setDraft(e.target.value);setRequest(null)}} />
            <span className="field-row__unit">章</span>
          </div>
        ) : tab==='foreshadow'&&field==='link' ? (
          /* 关联审核：两个章号各占一行（复用「字段名 + 窄输入框 + 单位」的既有范式） */
          <>
            <div className="field-row">
              <span className="field-row__label">埋设章</span>
              <input className="field field--num" type="number" min="1" max="999" value={linkPlantNo}
                aria-label="埋设章" onChange={e=>{setLinkPlantNo(e.target.value);setRequest(null)}} />
              <span className="field-row__unit">章</span>
            </div>
            <div className="field-row">
              <span className="field-row__label">回收章</span>
              <input className="field field--num" type="number" min="1" max="999" value={linkPayoffNo}
                aria-label="回收章" onChange={e=>{setLinkPayoffNo(e.target.value);setRequest(null)}} />
              <span className="field-row__unit">章</span>
            </div>
          </>
        ) : (
          <>
            {tab==='character'&&field==='reveal' ? (
              <div className="field-row">
                <span className="field-row__label">从第几章起可披露</span>
                <input className="field field--num" type="number" min="1" max="999" value={revealChapterNo}
                  aria-label="披露起始章" onChange={e=>{setRevealChapterNo(e.target.value);setRequest(null)}} />
                <span className="field-row__unit">章</span>
              </div>
            ) : null}
            <label className="edit-label edit-label--grow draft-grow">
              <span className="sr-only">{draftLabel||fieldLabel||'编辑内容'}</span>
              <textarea className="field" value={showOld ? (diffForCurrent?.before || '') : draft} readOnly={showOld}
                onChange={e=>{ if(showOld) return; setDraft(e.target.value); setRequest(null) }}
                placeholder={tab==='foreshadow'&&field==='add'?'例如：\n食堂阿姨总多给一勺\n她其实是主角的亲生母亲':(tab==='character'&&field==='relationships'?'例如：\n五十岚咲 | 学生会长/被撞对象 | 从冤家到互相理解\n星野遥 | 观察部部长 | 表面神秘实则守护旧部志':tab==='character'&&field==='reveal'?'例如：他终于说出了母亲的名字（只写读者可以知道的那一层）':'输入新的设定或修改要求')} />
            </label>
          </>
        )}
        {tab==='settings'&&field==='styleSpec'?<p className="setting-note">把文风、基调、节奏写在一起即可，例如「第三人称限知；冷峻克制、少形容词；场景描写放慢，对话紧凑」。三项已合并为一个字段，不用再分开填。</p>:null}
        {tab==='foreshadow'&&fs[index] ? <p className="setting-note">
          伏笔 ID：{fs[index].id} · 回收章：第 {fs[index].payoffChapter||fs[index].revealAt||'—'} 章 · 关联：{fs[index].linkStatus||'explicit'} · 回收授权：{fs[index].safeReveal?.approved?'已授权':'未授权'}
          {field==='safeReveal'
            ? '。填写「可以对读者说出的版本」并提交即完成授权；清空后提交＝撤回授权。原始回收真相（作者侧）永不进正文。'
            : field==='link'
            ? '。在这里确认「埋在哪一章、收在哪一章」。关联仍是 needsReview 时，模型一旦把回收排到某一章，那一章会被永久拦住（¥0，但写不出来）。两个章号至少填一个。'
            : '。修改回收真相不会自动授予正文揭示权限 —— 要授权请把「修改内容」改为「回收披露授权」。'}
        </p>:null}
        {tab==='character'&&chars[index] ? <p className="setting-note">
          实体 ID：{chars[index].id}。修改角色名后历史正文和账本的 ID 不变。
          {field==='reveal' ? '披露授权＝把「可以对读者说出的版本」和起始章一起提交；原始 secret 永不进正文，正文只会看到你写的这一版。该章计划里必须有这个角色出场，否则会被拒绝。' : ''}
        </p>:null}
        {tab==='foreshadow'&&field!=='add'&&fs[index] ? <button type="button" className="btn btn--ghost btn--sm" style={{marginTop:8}} onClick={removeForeshadow} disabled={busy}>删除这条伏笔</button>:null}
        {/* 「上次改动」清单：由服务端程序算出的前后对比，替代「模型自述」 */}
        {lastDiff.length ? <div className="diff-list">
          <div className="diff-list__title">上次改动（修订 {lastEdit.editRevision}）· {lastDiff.length} 处</div>
          {lastDiff.map((d,i)=><div className="diff-row" key={i}>
            <span className="diff-row__label">{d.label}</span>
            <span className="diff-row__old">{d.before||'（空）'}</span>
            <span className="diff-row__arrow">→</span>
            <span className="diff-row__new">{d.after||'（空）'}</span>
          </div>)}
        </div>:null}
        {error?<div role="alert" className="notice notice--err">{error}</div>:null}
        {notice?<div className="notice">{notice}</div>:null}
        {request ? <div className="change-preview">
          <strong>待确认修改 · {request.impact.risk==='high'?'高风险':request.impact.risk==='medium'?'中风险':'低风险'}</strong>
          <p>{request.impact.warning}</p>
          <p>影响章节：{request.impact.affectedChapters?.slice(0,30).join('、') || '未检测到规划引用'}（含已写关联 {request.impact.committedChapterCount} 条）</p>
          <p className="setting-note">操作：{request.change.kind}。确认前不会修改正式作品。</p>
        </div> : null}
      </div>
      {/* 贴底操作条：与「剧情方向修改」页共用 .footer-actions，两个入口长一个样 */}
      {request ? <div className="footer-actions">
        <button className="btn btn--ghost" disabled={busy} onClick={reject}>取消</button>
        <button className="btn btn--primary btn--grow" disabled={busy} onClick={confirm}>{busy?'提交中…':'确认并提交'}</button>
      </div> : <div className="footer-actions">
        <button className="btn btn--ghost" disabled={busy} onClick={()=>onAssistant?.(`请分析当前${TABS.find(t=>t.id===tab)?.label}的修改建议，未经同意不要修改其他部分。`)}>让 AI 分析</button>
        <button className="btn btn--primary btn--grow" disabled={busy || showOld || !canSubmit() || !changed()} onClick={preview}>{busy?'分析中…':'预览影响'}</button>
      </div>}
  </>
}
