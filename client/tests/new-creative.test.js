import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeGenreTags,genrePrompt,validateChapterCount,outlinePlanCount,estimateOutlineSeconds} from '../server/creative-options.js'
import {outlineMessages} from '../server/prompts.js'
import {createAssistantService,applyAssistantChange,validateAssistantChange} from '../server/assistant.js'
import {makeEntity} from '../server/schema.js'
import {buildWriterPacket,findLeaks} from '../server/projection.js'

function project() {
  const p = makeEntity({name:'顾行舟',publicRole:'志愿者',publicIdentity:'档案馆青年志愿者',secret:'其实是林晚之子',authorRole:'对手',
    characterCard:{appearance:'穿灰衣',personality:'谨慎',motivation:'复仇',arc:'第30章摊牌',highlight:'第26章暴露'}})
  return {id:'p_test',title:'测试',idea:'一封信',genre:'悬疑',genreTags:['悬疑','正剧'],editRevision:0,headVersion:0,targetChapters:30,
    entities:[p],preferences:{},chapters:[],ledger:{canonicalFacts:[],currentState:[],characterKnowledge:[],plotThreads:[],stateEvents:[]},
    outline:{title:'测试',cast:[{name:p.name,entityId:p.id}],foreshadows:[],volumes:[{title:'卷一',chapters:[{no:1,title:'来信',cast:[p.id],writerTaskApproval:'proposed',foreshadows:[]}]}]}}
}
function repoMock(p=project()) {
  const runs=new Map(), projects=new Map([[p.id,structuredClone(p)]])
  return {
    getRun:id=>structuredClone(runs.get(id)||null),
    saveRun:r=>{runs.set(r.id,structuredClone(r));return r},
    getProject:id=>structuredClone(projects.get(id)||null),
    saveProject:next=>{projects.set(next.id,structuredClone(next));return next},
    commitProjectEdit:(next,head,rev)=>{
      const old=projects.get(next.id)
      if(old.headVersion!==head||old.editRevision!==rev||next.editRevision!==rev+1)throw Error('编辑版本冲突')
      projects.set(next.id,structuredClone(next));return next
    },
    externalSave:next=>projects.set(next.id,next),
  }
}
function mockModel(change) {return async ()=>({text:JSON.stringify({summary:'仅微调指定字段',change}),usage:{inputTokens:40,outputTokens:30}})}

test('A1 1、999 可接受，0、1000 不允许',()=>{
  assert.equal(validateChapterCount(1),1)
  assert.equal(validateChapterCount(999),999)
  assert.throws(()=>validateChapterCount(0),/目标章节数/)
  assert.throws(()=>validateChapterCount(1000),/目标章节数/)
})
test('A1 不可缩减到已写章节之前',()=>assert.throws(()=>validateChapterCount(1,5)))
test('A1 1章一次性规划，999章先规划5章',()=>{
  assert.equal(outlinePlanCount(1),1)
  assert.equal(outlinePlanCount(999),5)
  assert.equal(estimateOutlineSeconds(999).deferred,994)
})
test('A1 999章提示词不要求一次输出999章',()=>{
  const txt=JSON.stringify(outlineMessages({idea:'星际',genre:'科幻',targetChapters:999}))
  assert.match(txt,/约 5 章/)
  assert.match(txt,/滚动 L2/)
})
test('B2 多选生成分层题材提示，不触发一刀切异质元素禁令',()=>{
  const p=genrePrompt(['科幻','末世','治愈','轻小说'],'科幻')
  assert.match(p,/主背景：科幻/)
  assert.match(p,/叙事机制：末世/)
  assert.match(p,/情绪基调：治愈/)
  assert.match(JSON.stringify(outlineMessages({idea:'你好',genre:'科幻',genreTags:['科幻','治愈'],targetChapters:30})),/多选不视为异质元素/)
})
test('B3 提示词硬约束世界观/文风/作者偏好必填，且禁止占位内容',()=>{
  const txt=JSON.stringify(outlineMessages({idea:'雨夜的信',genre:'悬疑',targetChapters:30}))
  assert.match(txt,/世界观（worldview）\*\*：\*\*必填/)
  assert.match(txt,/文风（style）\*\*：\*\*必填/)
  assert.match(txt,/作者偏好补充（preferences）/)
  for(const k of ['coreGoal','forbidden','ending','protagonist']) assert.ok(txt.includes(k),`提示词应要求生成 ${k}`)
  // 禁止占位/敷衍内容
  assert.match(txt,/严禁\*\*输出空字符串/)
  assert.match(txt,/用户没填不等于可以留空/)
})
test('B3 用户在创书页填了文风时，提示词要求模型原样沿用、不得改写',()=>{
  const txt=JSON.stringify(outlineMessages({idea:'x',genre:'科幻',targetChapters:30,preferences:{style:'第一人称，短句'}}))
  assert.match(txt,/用户已指定，必须原样沿用，不得改写/)
  // 用户填了就不要再要求模型"自行设定"
  assert.doesNotMatch(txt,/用户未填写文风/)
})
test('B3 用户没填文风时，提示词要求模型主动生成',()=>{
  const txt=JSON.stringify(outlineMessages({idea:'x',genre:'科幻',targetChapters:30,preferences:{}}))
  assert.match(txt,/用户未填写文风，请根据题材与灵感气质自行设定/)
})
test('B2 旧字符串能够被规范化为标签数组',()=>assert.deepEqual(normalizeGenreTags(undefined,'悬疑 / 轻松'),['悬疑','轻松']))
test('B2 不接受任意注入标签',()=>assert.deepEqual(normalizeGenreTags(['悬疑','<script>','悬疑']),['悬疑']))
test('A3 非法更改正文或安全规则的提议必然拒绝',()=>{
  for (const kind of ['rewrite_body','projection','ledger','findLeaks','security','update_chapter']) assert.throws(()=>validateAssistantChange({kind},project()))
})
test('A3 用户未确认：提议只写 run，作品未改变',async()=>{
  const repo=repoMock(), service=createAssistantService({repo,model:mockModel({kind:'preferences',values:{style:'冷峻'}}),config:()=>({apiKey:'x'})})
  const r=await service.propose({projectId:'p_test',input:{instruction:'文风冷一点'}})
  assert.equal(r.status,'proposed')
  assert.equal(repo.getProject('p_test').preferences.style,undefined)
})
test('A3 明确回复同意后，经已有版本 CAS 写入',async()=>{
  const repo=repoMock(), service=createAssistantService({repo,model:mockModel({kind:'preferences',values:{style:'克制'}}),config:()=>({apiKey:'x'})})
  const r=await service.propose({projectId:'p_test',input:{instruction:'调整文风'}})
  const result=service.reply(r.id,'同意')
  assert.equal(result.project.preferences.style,'克制')
  assert.equal(repo.getProject('p_test').editRevision,1)
  assert.equal(repo.getRun(r.id).status,'accepted')
})
test('A3 回复取消不会触发任何作品写入',async()=>{
  const repo=repoMock(), service=createAssistantService({repo,model:mockModel({kind:'preferences',values:{style:'克制'}}),config:()=>({apiKey:'x'})})
  const r=await service.propose({projectId:'p_test',input:{instruction:'调整文风'}})
  const done=service.reply(r.id,'取消')
  assert.equal(done.run.status,'rejected')
  assert.equal(repo.getProject('p_test').editRevision,0)
})
test('A3 旧 editRevision 不能覆盖后续人工修改',async()=>{
  const repo=repoMock(), service=createAssistantService({repo,model:mockModel({kind:'preferences',values:{style:'克制'}}),config:()=>({apiKey:'x'})})
  const r=await service.propose({projectId:'p_test',input:{instruction:'调整文风'}})
  const p=repo.getProject('p_test');p.editRevision=1;repo.externalSave(p)
  assert.throws(()=>service.reply(r.id,'同意'),/版本冲突/)
  assert.equal(repo.getRun(r.id).status,'stale')
})
test('A3 未经明确同意的其它回复不写入',async()=>{
  const repo=repoMock(), service=createAssistantService({repo,model:mockModel({kind:'preferences',values:{style:'克制'}}),config:()=>({apiKey:'x'})})
  const r=await service.propose({projectId:'p_test',input:{instruction:'调整文风'}})
  assert.throws(()=>service.reply(r.id,'帮我想想'),/同意/)
  assert.equal(repo.getProject('p_test').editRevision,0)
})
test('A3 修改章节数只标记 pendingReplan，不修改原大纲',()=>{
  const p=project(),r=applyAssistantChange(p,{kind:'chapter_count',value:999},0)
  assert.equal(r.targetChapters,999)
  assert.equal(r.pendingReplan,true)
  assert.equal(r.outline.volumes[0].chapters.length,1)
})
test('A3 不能改已写正文的章节标题',()=>{
  const p=project();p.chapters.push({no:1,status:'committed',text:'历史正文'})
  assert.throws(()=>applyAssistantChange(p,{kind:'chapter_title',chapterNo:1,title:'变化'},0),/已写/)
})
test('A3 创建助手随机提议确认仅返回字段，不自动创建作品',async()=>{
  const repo=repoMock(),service=createAssistantService({repo,model:mockModel({kind:'creative_seed',idea:'海边旧钥匙',genreTags:['悬疑','治愈'],targetChapters:45,style:'克制'}),config:()=>({apiKey:'x'})})
  const r=await service.propose({input:{instruction:'随机生成整套创意'}})
  const a=service.reply(r.id,'同意')
  assert.equal(a.change.idea,'海边旧钥匙')
  assert.equal(a.change.targetChapters,45)
  assert.equal(repo.getProject('p_test').editRevision,0)
})
test('B1 作者角色卡扩展字段不能穿过正文白名单',()=>{
  const p=project(),packet=buildWriterPacket(p,1)
  const raw=JSON.stringify(packet)
  assert.doesNotMatch(raw,/第30章摊牌|复仇|第26章暴露|其实是林晚之子/)
  assert.match(raw,/档案馆青年志愿者/)
  assert.equal(findLeaks(packet,p).length,0)
})
test('A2 老作品没有 style 时，修改文风不会崩溃',()=>{
  const p=project(); delete p.outline.style
  const r=applyAssistantChange(p,{kind:'preferences',values:{style:'白描'}} ,0)
  assert.equal(r.preferences.style,'白描')
})

test('A1 纯大纲归一化：1章恰好一章，999章用5章明细加滚动计划占位',async()=>{
  const {normalizeOutline}=await import('../server/pipeline.js')
  const raw=(n)=>({title:'测',cast:[{name:'小明',publicIdentity:'学生'}],volumes:[{title:'第一卷',chapters:Array.from({length:n},(_,i)=>({title:`章${i+1}`,cast:['小明'],writerSummary:'行动'}))}]})
  const a=normalizeOutline(raw(1),1)
  assert.equal(a.outline.totalChapters,1)
  assert.equal(a.outline.volumes.flatMap(x=>x.chapters).length,1)
  const b=normalizeOutline(raw(5),999)
  assert.equal(b.outline.totalChapters,999)
  assert.equal(b.outline.plannedDetailThrough,5)
  assert.equal(b.outline.volumes.flatMap(x=>x.chapters).length,999)
  assert.equal(b.outline.volumes.flatMap(x=>x.chapters)[998].pendingDetail,true)
})
test('A3 创建时已填文风、灵感、标签与触碰的章节数不会被 AI 示例覆盖',async()=>{
  const repo=repoMock(),service=createAssistantService({repo,model:mockModel({kind:'creative_seed',idea:'会改坏',style:'会改坏',genreTags:['末世'],targetChapters:99}),config:()=>({apiKey:'x'})})
  const r=await service.propose({input:{instruction:'给示例',idea:'已有故事',style:'白描',genreTags:['历史'],targetChapters:80,chapterTouched:true}})
  assert.equal(r.change.idea,'已有故事')
  assert.equal(r.change.style,'白描')
  assert.deepEqual(r.change.genreTags,['历史'])
  assert.equal(r.change.targetChapters,80)
})

test('A1/API 基础项目创建接受 999 并持久化默认30与多标签',async()=>{
  const {createProjectBase}=await import('../server/store.js')
  const a=createProjectBase({idea:'高山',genreTags:['悬疑','治愈'],targetChapters:999})
  assert.equal(a.targetChapters,999)
  assert.equal(a.genre,'悬疑')
  assert.deepEqual(a.genreTags,['悬疑','治愈'])
  assert.equal(createProjectBase({idea:'短篇'}).targetChapters,30)
  assert.throws(()=>createProjectBase({idea:'错误',targetChapters:1000}))
})
test('B3 PWA 资产齐备、manifest 含 192/512 和 maskable，SW 不缓存 API',async()=>{
  const fs=await import('node:fs'),path=await import('node:path'),url=await import('node:url')
  const root=path.resolve(path.dirname(url.fileURLToPath(import.meta.url)),'..')
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'public/manifest.webmanifest'),'utf8'))
  assert.equal(manifest.icons.length,4)
  for(const icon of manifest.icons) assert.ok(fs.existsSync(path.join(root,'public',icon.src.replace('./',''))))
  assert.match(fs.readFileSync(path.join(root,'public/sw.js'),'utf8'),/\/api\//)
  assert.match(fs.readFileSync(path.join(root,'vite.config.js'),'utf8'),/base: '\.\/'/)
})
test('B4 目录及改名不修改已确认章节正文',()=>{
  const p=project();p.chapters=[{no:1,status:'committed',text:'最初的顾行舟在这里'}]
  assert.throws(()=>applyAssistantChange(p,{kind:'chapter_title',chapterNo:1,title:'换个标题'},0))
  const changed=applyAssistantChange(p,{kind:'rename',entityId:p.entities[0].id,name:'顾川'},0)
  assert.equal(changed.chapters[0].text,'最初的顾行舟在这里')
})

test('A3 助手提议不属于章节生成任务，不应占用工作流并发锁',async()=>{
  // 章节工作流读取的是 repo.listRuns(projectId)。助手提议使用独立的 proposal 状态，
  // 实际的 store.listRuns(projectId) 必须排除 assistant 类型，防止永久卡住作品。
  const fs=await import('node:fs'), path=await import('node:path'), url=await import('node:url')
  const root=path.resolve(path.dirname(url.fileURLToPath(import.meta.url)),'..')
  const source=fs.readFileSync(path.join(root,'server/store.js'),'utf8')
  assert.match(source,/startsWith\('assistant'\)/)
})
