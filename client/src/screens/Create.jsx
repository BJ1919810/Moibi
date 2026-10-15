import { useRef, useState } from 'react'
import { api } from '../lib/api.js'
import Loading from '../components/Loading.jsx'
import AssistantBox from '../components/AssistantBox.jsx'

/** v1 taxonomy 的完整 5 组 40 标签；多选值以结构化数组发送后端。 */
export const GENRE_GROUPS = {
  '大题材背景': ['玄幻','奇幻','仙侠','武侠','科幻','都市','历史','军事','悬疑','现实'],
  '核心设定与模式': ['系统流','废柴流','种田','基建','无限流','快穿','穿书','重生','末世','废土'],
  '衍生形态': ['同人','二次元','轻小说'],
  '文风基调': ['搞笑','轻松','热血','黑暗','甜宠','治愈','正剧','沙雕','虐心'],
  '其他常用': ['修真','青春校园','言情','恐怖','诡秘怪谈','灵气复苏','游戏','诸天无限'],
}

export default function Create({ onCreated }) {
  const [idea, setIdea] = useState('')
  const [genreTags, setGenreTags] = useState([])
  const [targetChapters, setTargetChapters] = useState(30)
  const [chapterTouched, setChapterTouched] = useState(false)
  const [style, setStyle] = useState('')
  const [showTags, setShowTags] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const assistantRef = useRef(null)
  /** 灵感是必填项：空（或纯空白）时「交给墨笔」保持禁用，避免点下去才知道要填。 */
  const canSubmit = !!idea.trim()

  const toggleTag = (tag) => setGenreTags((before) => before.includes(tag)
    ? before.filter((x) => x !== tag) : [...before,tag])

  const submit = async () => {
    // 按钮在灵感为空时是禁用的，正常点不到这里；保留作为兜底（防键盘回车 / 自动化绕过）。
    if (!canSubmit) return
    setBusy(true);setErr('')
    try {
      const genre = genreTags.find((x)=>GENRE_GROUPS['大题材背景'].includes(x)) || genreTags[0] || '玄幻'
      const {project} = await api.createProject({idea:idea.trim(),genre,genreTags,targetChapters,preferences:{style}})
      onCreated(project)
    } catch (e) {setErr(e.message);setBusy(false)}
  }
  const useAssistantChange = ({change}) => {
    if (!change) return
    if (change.kind === 'creative_seed') {
      setIdea(idea.trim() || change.idea || '')
      setGenreTags(genreTags.length ? genreTags : (change.genreTags || []))
      if (!chapterTouched) setTargetChapters(change.targetChapters || 30)
      setStyle(style.trim() || change.style || '')
    } else if (change.kind === 'preferences' && typeof change.values?.style === 'string') setStyle(change.values.style)
    else if (change.kind === 'chapter_count') setTargetChapters(Number(change.value))
  }

  if (busy) return <Loading text="正在构思作品架构……"
    hint={targetChapters > 5 ? `目标 ${targetChapters} 章。先生成三幕及全书里程碑，只细化开篇约 3～5 章；后续分组按需细化。` : `目标 ${targetChapters} 章。正在生成全书架构；耗时由模型响应决定。`} />

  return <>
    <div className="section-title">你的灵感 <span className="section-hint">必填</span></div>
    <textarea className="field field--area" value={idea} onChange={(e)=>setIdea(e.target.value)} rows={4}
      placeholder="一句话就够，例如：主角在雨夜收到来自十年后的信" />
    <div className="section-title">题材 <span className="section-hint">{genreTags.length ? `已选 ${genreTags.length} 项` : '可选'}</span></div>
    <button type="button" className="btn btn--ghost" onClick={()=>setShowTags(true)}>选择题材标签</button>
    {showTags && <div className="modal-mask" onClick={()=>setShowTags(false)}>
      <div className="modal-card" onClick={(e)=>e.stopPropagation()}>
        <div className="section-title">选择题材</div>
        {Object.entries(GENRE_GROUPS).map(([group,tags])=><div key={group} className="genre-block">
          <div className="setting-note">{group}</div>
          <div className="chips">{tags.map((g)=><button key={g} type="button"
            className={`chip${genreTags.includes(g)?' chip--on':''}`} aria-pressed={genreTags.includes(g)}
            onClick={()=>toggleTag(g)}>{g}</button>)}</div>
        </div>)}
        <button className="btn btn--primary" onClick={()=>setShowTags(false)}>完成</button>
      </div>
    </div>}
    <div className="section-title">篇幅 <span className="section-hint">{targetChapters} 章</span></div>
    <input aria-label="目标章节数" type="range" className="chapter-range" min="1" max="999" step="1"
      value={targetChapters} onChange={(e)=>{setChapterTouched(true);setTargetChapters(Number(e.target.value))}} />
    <div className="range-ends"><span>1 章</span><strong>{targetChapters} 章</strong><span>999 章</span></div>
    <div className="setting-note">{targetChapters > 5 ? `本次先细化开篇 3～5 章，其余章节按进度每组最多细化 5 章。` : `本次细化开篇全部 ${targetChapters} 章。`}实际费用取决于模型、重试与篇幅。</div>
    <div className="section-title">文风 <span className="section-hint">可选，后续可修改</span></div>
    <textarea className="field" rows={3} value={style} onChange={(e)=>setStyle(e.target.value)}
      placeholder="例如：第三人称限知、冷峻克制、对白多、避免长篇心理解释；留空由 AI 建议" />
    <AssistantBox draft={{idea,genreTags,targetChapters,style,chapterTouched}} onApply={useAssistantChange} requestRef={assistantRef} />
    {err && <div className="notice notice--err">{err}</div>}
    <div className="footer-actions"><button className="btn btn--primary btn--lg" disabled={busy||!canSubmit} onClick={submit}>交给墨笔</button></div>
  </>
}
