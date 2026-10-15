/**
 * AI 创作助手：模型只有「提议权」，没有写库权。
 * 每个提议写成已有 run 存储的一个 proposed 记录；确认时统一走项目
 * editRevision / headVersion CAS。正文、投影、账本和安全规则都没有入口。
 */
import crypto from 'node:crypto'
import { chat } from './providers/openai.js'
import { updateAuthorSettings, ALLOWED_PREFS } from './author-control.js'
import { createChangeService, previewChangeDiff } from './change-request.js'
import { validateChapterCount, normalizeGenreTags, primaryGenre } from './creative-options.js'
import * as store from './store.js'

const MAX_MSG = 600
// 偏好白名单**只此一处**（author-control 的 ALLOWED_PREFS）。
// ⛔ 这里曾经单独抄了一份，而且**漏了 `styleSpec`** —— 而 `styleSpec` 是界面唯一入口写的字段、
//    也是投影与提示词唯一读取的字段（它存在时会屏蔽 style/tone/pace）
//    ⇒ 作者让助手改文风时助手只能写 `style`：落库成功、钱也花了、`editRevision` 也 +1，
//    但正文提示词**一字不变**（一次静默无效的修改）。
const ASSISTANT_FIELDS = ALLOWED_PREFS
const EDIT_KINDS = new Set(['preferences','rename','book_title','chapter_title','reader_intro','chapter_count','creative_seed'])
const hashId = () => `run_${crypto.randomBytes(12).toString('hex')}`
const clean = (s, cap=160) => String(s ?? '').trim().slice(0,cap)

// 明确拒绝借助自然语言描述扩权。只读字符串，程序再裁定可写字段。
export function validateAssistantChange(change, project = null) {
  if (!change || !EDIT_KINDS.has(change.kind)) throw new Error('助手提出了不允许的修改类型')
  const c = structuredClone(change)
  if (c.kind === 'creative_seed') {
    if (project) throw new Error('随机创意仅用于创建表单')
    c.idea = clean(c.idea,1200)
    c.style = clean(c.style,800)
    c.genreTags = normalizeGenreTags(c.genreTags,c.genre || '')
    c.genre = primaryGenre(c.genreTags,c.genre || '悬疑')
    c.targetChapters = validateChapterCount(c.targetChapters ?? 30)
    if (!c.idea) throw new Error('随机灵感为空')
  } else if (c.kind === 'preferences') {
    if (!c.values || typeof c.values !== 'object' || Object.keys(c.values).length < 1) throw new Error('缺少偏好内容')
    for (const [key,value] of Object.entries(c.values)) {
      if (!ASSISTANT_FIELDS.has(key) || typeof value !== 'string' || value.length > 1200) throw new Error('助手修改了不允许的偏好字段')
    }
  } else if (c.kind === 'rename') {
    if (!project || !(project.entities || []).some((e) => e.id === c.entityId) || !clean(c.name,33) || c.name.length > 32) throw new Error('人物改名缺少有效 ID')
  } else if (c.kind === 'chapter_title') {
    if (!project) throw new Error('仅已建立作品允许修改章节标题')
    const no = Number(c.chapterNo)
    const existing = (project.outline?.volumes || []).flatMap((v)=>v.chapters || []).find((x)=>x.no === no)
    if (!existing || (project.chapters || []).some((x)=>x.no === no && x.status === 'committed')) throw new Error('正文已写或章节不存在，拒绝修改')
    if (!clean(c.title,80)) throw new Error('章节标题为空')
  } else if (c.kind === 'book_title' || c.kind === 'reader_intro') {
    if (!project) throw new Error('该提议需要已有作品')
    if (!clean(c.value, c.kind === 'book_title' ? 30 : 200)) throw new Error('新内容为空')
  } else if (c.kind === 'chapter_count') {
    // 章数由既有作者控制系统处理，只会标 pendingReplan，不直接改大纲。
    validateChapterCount(c.value, project ? Math.max(0, ...(project.chapters || []).filter((x)=>x.status==='committed').map((x)=>x.no)) : 0)
  }
  return c
}

export function applyAssistantChange(project, change, expectedEditRevision) {
  if (Number(project.editRevision || 0) !== Number(expectedEditRevision)) throw new Error('编辑版本冲突')
  const c = validateAssistantChange(change, project)
  if (c.kind === 'preferences') return updateAuthorSettings(project, {preferences:c.values}, expectedEditRevision)
  if (c.kind === 'rename') return updateAuthorSettings(project, {rename:{entityId:c.entityId,name:c.name}}, expectedEditRevision)
  if (c.kind === 'chapter_count') return updateAuthorSettings(project, {targetChapters:c.value}, expectedEditRevision)
  const next = structuredClone(project)
  if (c.kind === 'book_title') {
    next.title = clean(c.value,30)
    if (next.outline) next.outline.title = next.title
  }
  if (c.kind === 'reader_intro') {
    next.outline ||= {}
    // 不直接批准为公开简介：仍须经过正文投影的批准标记。
    next.outline.readerLogline = clean(c.value,200)
    next.outline.publicLoglineApproved = false
  }
  if (c.kind === 'chapter_title') {
    const meta = next.outline.volumes.flatMap((v)=>v.chapters || []).find((x)=>x.no===Number(c.chapterNo))
    meta.title = clean(c.title,80)
  }
  next.editRevision = Number(next.editRevision || 0) + 1
  next.editHistory ||= []
  next.editHistory.push({ revision: next.editRevision, at: new Date().toISOString(), fields: ['assistant:'+c.kind] })
  return next
}

function assistantMessages({ project, input, create = false }) {
  const visible = create ? {
    idea: clean(input.idea,2000), genre:input.genre, genreTags: normalizeGenreTags(input.genreTags,input.genre),
    targetChapters:input.targetChapters, style: input.style || '',
  } : {
    title: project.title, idea: project.idea, genre: project.genre, genreTags: project.genreTags || [],
    targetChapters: project.targetChapters, preferences:project.preferences || {},
    characters: (project.entities || []).map(({id,name,publicIdentity})=>({id,name,publicIdentity})),
    futureChapters: (project.outline?.volumes || []).flatMap((v)=>v.chapters || []).filter((c)=>!(project.chapters || []).some((x)=>x.no===c.no && x.status==='committed')).slice(0,24).map(({no,title})=>({no,title})),
  }
  return [
    {role:'system',content:`你是墨笔的 AI 创作助手，只能提出少量定向修改。不得修改已有正文、正式状态账本、权限映射、安全门禁、角色真相与大纲核心因果。
不允许擅自改全书结构或已写章节。若用户要大范围重构，给出拒绝修改的提议，让用户使用正式重排流程。
你没有任何数据库工具，也不能直接执行操作。只输出 JSON：{"summary":"不超过70字的简要改动说明","change":{...}}。
允许的 change.kind：preferences(values 只能含 styleSpec/protagonist/ending/forbidden/coreGoal；**文风一律用合并字段 styleSpec**，不要再用 style/tone/pace)、rename(entityId,name)、book_title(value)、chapter_title(chapterNo,title)、reader_intro(value)、chapter_count(value)。
创建页允许 creative_seed(idea,genreTags,genre,targetChapters,style) 一次随机整套，或 preferences / chapter_count 单项修改；建议尽量只改用户指定的字段。`},
    {role:'user',content:`当前${create?'创建参数':'作者侧作品摘要'}：${JSON.stringify(visible)}\n用户请求：${clean(input.instruction || input.message, MAX_MSG)}\n必须先输出简要修改说明等待用户用回复确认。不要输出正文。`}
  ]
}

export function createAssistantService({repo=store, model=chat, config=store.getConfig}={}) {
  async function propose({ projectId = null, input = {} }={}) {
    const project = projectId ? repo.getProject(projectId) : null
    if (projectId && !project) throw new Error('作品不存在')
    const isCreate = !projectId
    if (!clean(input.instruction || input.message,MAX_MSG)) throw new Error('请输入想调整的内容')
    const messages = assistantMessages({project,input,create:isCreate})
    const response = await model({...config(),messages,thinking:false,temperature:.35,maxTokens:360,jsonMode:true,retries:0})
    if (response.finishReason === 'length') throw new Error('助手提议被截断，请缩短要求')
    const parsed = JSON.parse(String(response.text||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim())
    const change = validateAssistantChange(parsed.change,project)
    if (isCreate && change.kind === 'creative_seed') {
      // 示例不能擅自覆盖用户已经填好的参数；保留空白字段给模型发挥。
      if (String(input.idea || '').trim()) change.idea = clean(input.idea,1200)
      if (String(input.style || '').trim()) change.style = clean(input.style,800)
      const specifiedTags = normalizeGenreTags(input.genreTags,input.genre || '')
      if (specifiedTags.length) {change.genreTags=specifiedTags;change.genre=primaryGenre(specifiedTags,input.genre)}
      if (input.chapterTouched === true) change.targetChapters=validateChapterCount(input.targetChapters)
    }
    // 「改了什么」由**程序**在副本上试算出来（主人反馈：模型自述的 summary 太模糊，
    // 分不清是规则层允许的内容还是它的原生回答 —— 答案是：summary 是原生回答，
    // 只有 change 过了白名单。所以这里额外给一份确定性的前后对比）。
    let diff = []
    if (project && change.kind !== 'creative_seed') {
      try { diff = previewChangeDiff(project, change) } catch { diff = [] }   // 预览失败不影响提议本身
    }
    // 不存任何模型生成的越权字段；只保留白名单变更。
    const run = {
      id: hashId(), type: isCreate?'assistant-create':'assistant', projectId,
      status:'proposed', summary:clean(parsed.summary,140) || '有一项待确认修改', change, diff,
      baseHeadVersion:project?.headVersion || 0, baseEditRevision:project?.editRevision || 0,
      createdAt:new Date().toISOString(), usage: [{...(response.usage||{}),step:'assistant-proposal'}],
    }
    repo.saveRun(run)
    return run
  }
  // 服务端不把按钮事件等同确认。必须收到用户明确回复。拒绝则直接终止提议。
  function reply(runId, message) {
    const run = repo.getRun(runId)
    if (!run || !['assistant','assistant-create'].includes(run.type)) throw new Error('助手提议不存在')
    if (run.status !== 'proposed') throw new Error('此提议已经处理')
    const words = clean(message,80)
    if (/^(不同意|取消|拒绝|否|不要|驳回)$/.test(words)) {
      run.status='rejected';repo.saveRun(run);return {run}
    }
    if (!/^(同意|确认|可以|执行|应用|好)$/.test(words)) throw new Error('请回复“同意”或“取消”；其它内容请重新提交修改要求')
    if (run.type === 'assistant-create') {
      // 创建表单还没有项目：只返回待合并的局部变更，交由 UI 更新草稿，绝不创建项目。
      run.status='accepted';repo.saveRun(run);return {run,change:run.change}
    }
    const p = repo.getProject(run.projectId)
    if (!p || Number(p.headVersion||0)!==Number(run.baseHeadVersion) || Number(p.editRevision||0)!==Number(run.baseEditRevision)) {
      run.status='stale';repo.saveRun(run);throw new Error('编辑版本冲突，原提议失效，请重新提出')
    }
    // 正式存储仓库具备修改请求能力时，AI 确认也必须走同一个预览/CAS/审计提交通道。
    // 部分历史单元测试注入的轻量仓库不含 ChangeRequest 存储，保留旧接口兼容分支。
    if (typeof repo.saveChange==='function' && typeof repo.getChange==='function') {
      const c=run.change
      const mapped = c.kind==='preferences' ? {kind:'preferences_bulk',values:c.values}
        : c.kind==='rename' ? {kind:'rename',entityId:c.entityId,value:c.name}
        : c.kind==='chapter_title' ? {kind:'chapter_title',chapterNo:c.chapterNo,value:c.title}
        : c.kind==='chapter_count' ? {kind:'target_chapters',value:c.value}
        : {kind:c.kind,value:c.value}
      const service=createChangeService(repo)
      const preview=service.create(p.id,{...mapped,expectedHeadVersion:run.baseHeadVersion,expectedEditRevision:run.baseEditRevision})
      const {project:next,request}=service.approve(preview.id)
      run.status='accepted';run.changeRequestId=request.id;repo.saveRun(run)
      return {run,project:next,request}
    }
    const next = applyAssistantChange(p,run.change,run.baseEditRevision)
    if (repo.commitProjectEdit) repo.commitProjectEdit(next,run.baseHeadVersion,run.baseEditRevision)
    else repo.saveProject(next,{strict:true})
    run.status='accepted';repo.saveRun(run)
    return {run,project:next}
  }
  return {propose,reply}
}
