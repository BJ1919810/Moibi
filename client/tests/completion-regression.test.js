/**
 * 本轮收尾回归：P1 弹性窗口、空正文重试预算、滚动细化和高风险重排解锁。
 * 全部使用内存模型替身，不需要真实密钥，也不会消耗真实 token。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, emptyLedger } from '../server/schema.js'
import { normalizeOutline } from '../server/pipeline.js'
import { createWorkflow } from '../server/workflow.js'
import { createChangeService } from '../server/change-request.js'
import { applyRollingWindowPlan, createReplanService } from '../server/replan.js'

const clone = structuredClone
const extraction = JSON.stringify({summary:'主人公找到线索',facts:[],states:[],knowledge:[],threads:[],resolved:[]})
const usage = {inputTokens:20,outputTokens:5,reasoningTokens:0}
const rawOutline = n => ({title:'书',theme:'命运',acts:[{name:'第一幕',summary:'开端'},{name:'第二幕',summary:'变化'},{name:'第三幕',summary:'结局'}],
  cast:[{name:'林舟',publicIdentity:'修复师',publicRole:'主角'}],
  volumes:[{title:'上卷',goal:'建立冲突',chapters:Array.from({length:n},(_,i)=>({title:`章${i+1}`,writerSummary:'寻得线索',cast:['林舟']}))},
    {title:'下卷',goal:'解决冲突',chapters:[]}] })

function project({target=9,detail=5,committed=0}={}) {
  const hero=makeEntity({name:'林舟',publicRole:'主角',authorRole:'主角',publicIdentity:'修复师'})
  const chapters=Array.from({length:target},(_,i)=>({ no:i+1,title:`第${i+1}章`,writerSummary:'找纸张',writerGoal:'取得证据',
    writerTaskApproval:i<detail?'author-approved':'proposed',cast:i<detail?[hero.id]:[],foreshadows:[],
    ...(i>=detail?{pendingDetail:true}:{}) }))
  return {id:'p_completion',schemaVersion:2,title:'档案',idea:'消失的档案',genre:'悬疑',targetChapters:target,
    headVersion:committed,editRevision:0,entities:[hero],chapters:Array.from({length:committed},(_,i)=>({no:i+1,status:'committed',text:'林舟寻找纸张。',summary:'调查'})),
    ledger:emptyLedger(),preferences:{},outline:{title:'档案',theme:'守护',totalChapters:target,
      plannedDetailThrough:detail,foreshadows:[],acts:[{name:'第一幕',summary:'开端'},{name:'第二幕',summary:'变化'},{name:'第三幕',summary:'终点'}],
      volumes:[{title:'卷一',chapters}]}}
}
function memoryRepo(initial) {
  const ps=new Map([[initial.id,clone(initial)]]),rs=new Map(),cs=new Map()
  return {
    getProject:id=>clone(ps.get(id) || null),saveProject:p=>{ps.set(p.id,clone(p));return p},
    getRun:id=>clone(rs.get(id)||null),saveRun:r=>{rs.set(r.id,clone(r));return r},listRuns:id=>[...rs.values()].filter(r=>!id||r.projectId===id).map(r=>clone(r)),
    getChange:id=>clone(cs.get(id)||null),saveChange:c=>{cs.set(c.id,clone(c));return c},listChanges:id=>[...cs.values()].filter(c=>c.projectId===id).map(r=>clone(r)),
    commitProjectEdit(next,head,rev){const current=ps.get(next.id)
      assert.equal(current.headVersion,head);assert.equal(current.editRevision,rev)
      assert.equal(next.editRevision,rev+1);ps.set(next.id,clone(next));return next},
    commitProjectVersion(next,head,rev){const current=ps.get(next.id)
      assert.equal(current.headVersion,head);assert.equal(current.editRevision,rev)
      assert.equal(next.headVersion,head+1);ps.set(next.id,clone(next));return next},
  }
}

test('P1: 30 章目标接受 3/4/5 章开篇，不把 30 当成一次性详细计划',()=>{
  for(const n of [3,4,5]){
    const {outline}=normalizeOutline(rawOutline(n),30)
    assert.equal(outline.totalChapters,30)
    assert.equal(outline.plannedDetailThrough,n)
    assert.equal(outline.volumes.flatMap(v=>v.chapters).length,30)
    assert.equal(outline.volumes.flatMap(v=>v.chapters).filter(c=>c.pendingDetail).length,30-n)
    assert.deepEqual(outline.volumeMilestones.map(m=>m.goal),['建立冲突','解决冲突'])
  }
})
test('P1: 多返回会截窗口、短篇不越目标，空/无效/不足规划必须失败',()=>{
  const r=normalizeOutline(rawOutline(25),30)
  assert.equal(r.outline.plannedDetailThrough,5)
  assert.equal(r.outline.volumes.flatMap(v=>v.chapters).length,30)
  const short=normalizeOutline(rawOutline(2),2)
  assert.equal(short.outline.totalChapters,2)
  assert.throws(()=>normalizeOutline(rawOutline(2),30),/至少/)
  assert.throws(()=>normalizeOutline(rawOutline(0),30),/至少/)
  assert.throws(()=>normalizeOutline({...rawOutline(0),volumes:[{chapters:[null,{},'bad',{title:''}]}]},30),/至少/)
  assert.throws(()=>normalizeOutline({...rawOutline(4),cast:[]},30),/角色/)
})

// 模型对「建议开篇约 N 章」并不严格，经常一次返回十几章。这些章是**已经付过费的完整规划**，
// 直接砍掉等于白花一次调用。现在的做法：前 window 章保持已细化，多出来的降级成
// 「带内容的占位」——内容留着，但仍 pendingDetail，正文门禁照样拦。
test('P1: 模型多返回的章节不再丢弃，降级为带内容的占位',()=>{
  const raw = rawOutline(12)
  // 给溢出的章节写上可辨认的内容，验证它们确实被保留而不是被砍掉
  raw.volumes[0].chapters = raw.volumes[0].chapters.map((c,i)=>({...c,summary:`摘要${i+1}`}))
  const r=normalizeOutline(raw,136)
  const chs=r.outline.volumes.flatMap(v=>v.chapters)
  assert.equal(chs.length,136)
  assert.equal(chs.filter(c=>!c.pendingDetail).length,5,'开篇窗口仍是 5 章')
  assert.equal(chs.filter(c=>c.pendingDetail&&c.summary).length,7,'第 6～12 章带着模型写好的内容留下来')
  // 内容确实保留了
  assert.equal(chs[5].title,'章6')
  assert.equal(chs[5].summary,'摘要6')
  assert.equal(chs[11].pendingDetail,true)
  // 章号连续无洞（第 13 章起是纯占位）
  assert.deepEqual(chs.map(c=>c.no),Array.from({length:136},(_,i)=>i+1))
  assert.equal(chs[12].title,'待细化')
  assert.equal(chs[12].summary,'')
  // 降级占位不再携带未经校验的伏笔指令
  assert.deepEqual(chs[5].foreshadows,[])
})

test('P1: 恰好返回一个窗口时不多不少，占位从窗口之后接着排',()=>{
  const r=normalizeOutline(rawOutline(5),30)
  const chs=r.outline.volumes.flatMap(v=>v.chapters)
  assert.equal(chs.filter(c=>c.pendingDetail).length,25)
  assert.equal(chs.filter(c=>c.pendingDetail&&c.summary).length,0)
  assert.equal(r.outline.plannedDetailThrough,5)
})

// 降级占位不能污染模型给的剧情卷：否则「第一卷」会同时装着已细化的开篇计划和一串「待细化」，
// 卷标题与内容对不上。同时卷名必须唯一（曾出现两个「滚动规划 1」）。
test('P1: 降级占位统一收进「滚动规划」卷，卷名唯一且不污染剧情卷',()=>{
  const raw = rawOutline(12)
  raw.volumes[0].chapters = raw.volumes[0].chapters.map((c,i)=>({...c,summary:`摘要${i+1}`}))
  const r = normalizeOutline(raw, 136)
  const vols = r.outline.volumes
  // ① 剧情卷只装已细化的开篇窗口（夹具里模型给了「上卷」，空的下卷会被过滤掉）
  const story = vols[0]
  assert.equal(story.title, '上卷', '模型给的卷名要保留')
  assert.equal(story.chapters.length, 5, '上卷只应装已细化的 5 章')
  assert.ok(story.chapters.every(c=>!c.pendingDetail), '上卷里不应混入占位')
  // ② 卷名唯一，滚动卷按 1、2、3… 顺排
  const names = vols.map(v=>v.title)
  assert.equal(new Set(names).size, names.length, `卷名必须唯一，实际 ${JSON.stringify(names)}`)
  const rolling = names.filter(n=>/^滚动规划/.test(n))
  assert.deepEqual(rolling, rolling.map((_,i)=>`滚动规划 ${i+1}`), '滚动规划卷应连续编号')
  // ③ 占位全部落在滚动卷里
  for (const v of vols.slice(1)) assert.ok(v.chapters.every(c=>c.pendingDetail), `${v.title} 里应全是占位`)
})

// 模型把章节分散写在多个卷里时，溢出部分也要收进滚动卷，不能让后面的剧情卷继续膨胀。
test('P1: 多卷返回时溢出章节不塞回剧情卷',()=>{
  const cast=[{name:'林舟',role:'主角'}]
  const mk=(from,n)=>Array.from({length:n},(_,i)=>({no:from+i,title:`章${from+i}`,summary:`摘要${from+i}`}))
  const r=normalizeOutline({cast,volumes:[
    {title:'卷一',goal:'开局',chapters:mk(1,3)},
    {title:'卷二',goal:'发展',chapters:mk(4,9)},
  ]},30)
  const vols=r.outline.volumes
  assert.equal(vols[0].chapters.length,3,'卷一保持模型给的样子')
  assert.equal(vols[1].chapters.length,2,'卷二只留已细化的部分，不接收溢出')
  assert.ok(vols.slice(2).every(v=>/^滚动规划/.test(v.title)),'其余全是滚动规划卷')
  assert.equal(r.outline.volumes.flatMap(v=>v.chapters).length,30)
  assert.deepEqual(r.outline.volumes.flatMap(v=>v.chapters).map(c=>c.no),Array.from({length:30},(_,i)=>i+1))
})

test('正文首次为空时仅追加一次关闭思考重试，成功后版本提交且两次用量都保留',async()=>{
  const p=project({target:2,detail:2}),repo=memoryRepo(p),thought=[]
  let writes=0
  const model=async args=>{
    if(args.jsonMode) return {text:extraction,usage}
    thought.push(args.thinking);writes++
    return {text:writes===1?'':'林舟打开纸袋，得到第一张线索。',usage,finishReason:'stop'}
  }
  const wf=createWorkflow({repo,model,config:()=>({thinking:true,inputBudget:9000})})
  const run=wf.createRun(p.id,1)
  const result=await wf.process(run.id)
  assert.equal(result.status,'committed')
  assert.deepEqual(thought,[true,false])
  assert.equal(repo.getProject(p.id).headVersion,1)
  assert.equal(repo.getProject(p.id).chapters[0].text,'林舟打开纸袋，得到第一张线索。')
  assert.equal(result.emptyBodyRetryUsed,true)
  assert.equal(result.usage.length,3) // 两次正文与一次提取
})

test('正文连续为空后必须停下：不做第三次付费请求、不写项目、不写账本',async()=>{
  const p=project({target:2,detail:2}),repo=memoryRepo(p)
  let writes=0
  const wf=createWorkflow({repo,config:()=>({thinking:true,inputBudget:9000}),model:async args=>{
    if(args.jsonMode) throw Error('不应到达抽取')
    writes++;return {text:'',usage,finishReason:'length'}
  }})
  const run=wf.createRun(p.id,1)
  const result=await wf.process(run.id)
  assert.equal(result.status,'needs_input')
  assert.equal(writes,2)
  assert.equal(result.usage.length,2)
  assert.match(result.error,/最多.*一次/)
  assert.equal(repo.getProject(p.id).chapters.length,0)
  assert.equal(repo.getProject(p.id).headVersion,0)
})

test('供应商把空正文转换为错误时仍只重试一次且保留已计费 usage',async()=>{
  const p=project({target:2,detail:2}),repo=memoryRepo(p)
  let writes=0
  const wf=createWorkflow({repo,config:()=>({thinking:true,inputBudget:9000}),model:async args=>{
    if(args.jsonMode) throw Error('不应进行记忆提取')
    writes++
    throw Object.assign(Error('模型返回内容为空（finish_reason: length）'),{usage})
  }})
  const run=wf.createRun(p.id,1),result=await wf.process(run.id)
  assert.equal(writes,2);assert.equal(result.status,'needs_input')
  assert.equal(result.usage.length,2)
})

test('网络/接口异常不是空正文，禁止隐藏的二次重试',async()=>{
  const p=project({target:2,detail:2}),repo=memoryRepo(p)
  let calls=0
  const wf=createWorkflow({repo,config:()=>({thinking:true,inputBudget:9000}),model:async()=>{calls++;throw Error('供应商网络断开')}})
  const r=wf.createRun(p.id,1),result=await wf.process(r.id)
  assert.equal(result.status,'failed')
  assert.equal(calls,1)
  assert.equal(result.emptyBodyRetryUsed,undefined)
})

test('滚动窗口只细化当前5章，保护后续占位与正式章节，拒绝非法角色',async()=>{
  const p=project({target:13,detail:3,committed:1}),repo=memoryRepo(p)
  const engine=createReplanService({repo,config:()=>({}),model:async()=>({text:JSON.stringify({chapters:Array.from({length:5},(_,i)=>({title:`细化${i+4}`,cast:[p.entities[0].id],foreshadows:[]}))}),usage,finishReason:'stop'})})
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,4),/占位|细化/)
  const r=engine.create(p.id,{mode:'window'})
  assert.equal(r.windowStart,4);assert.equal(r.windowCount,5)
  await engine.process(r.id)
  assert.equal(engine.getRun(r.id).status,'committed')
  const after=repo.getProject(p.id),chs=after.outline.volumes.flatMap(v=>v.chapters)
  assert.equal(chs[2].title,p.outline.volumes[0].chapters[2].title)
  assert.equal(chs[3].title,'细化4')
  assert.equal(chs[7].title,'细化8')
  assert.equal(chs[8].pendingDetail,true)
  assert.equal(after.outline.plannedDetailThrough,8)
  assert.equal(after.chapters[0].text,p.chapters[0].text)
  assert.equal(after.headVersion,1);assert.equal(after.editRevision,1)
  // 编造的角色 id 现在只丢该条并记 warning，不再整批作废（真实模型最常见的写法漂移，
  // 旧行为会让「细化下一组」永远失败）；但章号仍必须紧接已细化区（第 9 章，此处已细化到 8）。
  assert.throws(()=>applyRollingWindowPlan(after,[{title:'毒',cast:['fake']}],{expectedHeadVersion:1,expectedEditRevision:1,fromNo:12}),/连续细化/)
  const lenient=applyRollingWindowPlan(after,[{title:'毒',cast:['fake'],foreshadows:[]}],{expectedHeadVersion:1,expectedEditRevision:1,fromNo:9})
  assert.deepEqual(lenient.project.outline.volumes.flatMap(v=>v.chapters).find(c=>c.no===9).cast,[])
  assert.ok(lenient.warnings.some(w=>w.includes('fake')))
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,12),/占位|细化/)
})

test('越界章号必须当场拒绝，不能建出「注定失败」的任务（全量压测胡来用例挖出）',()=>{
  const p=project({target:13,detail:3,committed:1}),repo=memoryRepo(p)
  // 真实踩坑：请求第 9999 章时服务返回 202 建了 run，随后才报「找不到第 9999 章规划」。
  // 根因是 `findChapterMeta(...)?.pendingDetail` —— 对越界章号 meta 是 null，
  // `null?.x` 为 undefined（假）⇒ 检查静默通过。必须显式判空。
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,9999),/不在作品规划范围内/)
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,99999),/不在作品规划范围内/)
  // 非法章号仍按原样拒绝
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,0),/章号无效/)
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,-1),/章号无效/)
  // 范围内的「未细化占位章」仍给出「去细化」的指引（原行为不变）
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,5),/占位|细化/)
  // 且拒绝路径不得留下任何 run 痕迹
  assert.equal((repo.listRuns(p.id)||[]).length,0,'拒绝时不应产生任务')
})

test('高风险用户确认→冻结→全局重排成功→解除冻结→恢复正文生成门禁',async()=>{
  const p=project({target:6,detail:5,committed:1}),repo=memoryRepo(p),changes=createChangeService(repo)
  const c=changes.create(p.id,{kind:'theme',value:'主题转向推理与信任'})
  changes.approve(c.id)
  assert.equal(repo.getProject(p.id).pendingReplan,true)
  assert.throws(()=>createWorkflow({repo}).createRun(p.id,2),/重排/)
  const engine=createReplanService({repo,config:()=>({}),model:async()=>({
    text:JSON.stringify({chapters:Array.from({length:5},(_,i)=>({title:`新计划${i+2}`,cast:[p.entities[0].id],foreshadows:[]}))}),usage,finishReason:'stop'
  })})
  const r=engine.create(p.id)
  await engine.process(r.id)
  assert.equal(engine.getRun(r.id).status,'committed')
  const after=repo.getProject(p.id)
  assert.equal(after.pendingReplan,false)
  assert.equal(after.editRevision,2)
  assert.equal(after.chapters[0].text,p.chapters[0].text)
  assert.equal(after.outline.volumes.flatMap(v=>v.chapters)[1].title,'新计划2')
  assert.ok(createWorkflow({repo}).createRun(p.id,2).id)
})

test('适配器遇到计费的空内容会暴露 usage，防止重试成本被漏记',async()=>{
  const {createServer}=await import('node:http')
  const {chat,ProviderError}=await import('../server/providers/openai.js')
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({
    choices:[{message:{content:'',reasoning_content:'思考过程已经耗尽输出'},finish_reason:'length'}],
    usage:{prompt_tokens:120,completion_tokens:280,completion_tokens_details:{reasoning_tokens:270}}
  }))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const port=server.address().port
    await assert.rejects(()=>chat({baseURL:`http://127.0.0.1:${port}`,apiKey:'stub',model:'mock',messages:[{role:'user',content:'test'}],thinking:true,retries:0}), e=>{
      assert.ok(e instanceof ProviderError)
      assert.deepEqual({...e.usage},{inputTokens:120,outputTokens:280,reasoningTokens:270,cachedInputTokens:0})
      return true
    })
  } finally {await new Promise(resolve=>server.close(resolve))}
})

test('确定性 run id 不能把一次失败变成永久钉死：再点一次必须真的重试',async()=>{
  // 真实踩坑（v2.0.0 全量 30 章压测第 18–25 章）：DeepSeek 网关抖动返回 `fetch failed`，
  // 这 8 章就此再也写不出来 —— 重跑压测时它们**连一次模型调用都没发生**，
  // 直接返回 41 分钟前的旧错误。因为 id 只由 `projectId|chapter-N-head-H-edit-E` 决定，
  // 只要没写进新章 id 就不变，而路由只在 `status==='queued'` 时才 `process()`。
  const p=project({target:2,detail:2}),repo=memoryRepo(p)
  let calls=0
  const flaky=async args=>{
    calls++
    if(calls===1) throw new Error('fetch failed')   // 第一跳：模拟网关抖动
    if(args.jsonMode) return {text:extraction,usage}
    return {text:'林舟打开纸袋，得到第一张线索。',usage,finishReason:'stop'}
  }
  const wf=createWorkflow({repo,model:flaky,config:()=>({inputBudget:9000})})
  const id=wf.createRun(p.id,1).id
  assert.equal((await wf.process(id)).status,'failed')
  assert.equal(repo.getProject(p.id).chapters.length,0,'失败时不得写项目')

  // 第二次「点生成本章」：必须回到 queued（可被路由 process），而不是把旧失败原样丢回来
  const again=wf.createRun(p.id,1)
  assert.equal(again.id,id,'确定性 id 不变（这一条是前提）')
  assert.equal(again.status,'queued','命中失败任务必须就地重置为 queued，否则用户点了没反应')
  assert.equal(again.error,undefined,'必须清掉上次的报错，否则界面一边重试一边挂旧错误')
  assert.equal((await wf.process(again.id)).status,'committed')
  assert.equal(repo.getProject(p.id).chapters.length,1)
  assert.equal(calls,3,'第一跳失败 1 次 + 重试的正文与抽取各 1 次')
})

test('已付费草稿停住的 needs_input 绝不能被「再点一次」自动重跑（会二次扣费）',async()=>{
  // 与上一条配对：`failed` 安全可重跑，是因为按 process 的 catch 分支
  // `status = run.draft?.text ? 'needs_input' : 'failed'` ⇒ failed 严格等价于「无草稿、零花费」。
  // 反过来，needs_input 手里握着**已付费**草稿，绝不能被无脑重置成 queued。
  const p=project({target:2,detail:2}),repo=memoryRepo(p)
  let writes=0
  const wf=createWorkflow({repo,config:()=>({thinking:true,inputBudget:9000}),model:async args=>{
    if(args.jsonMode) throw Error('不应到达抽取')
    writes++;return {text:'',usage,finishReason:'length'}   // 正文为空 ⇒ 无草稿
  }})
  const run=wf.createRun(p.id,1)
  const st=(await wf.process(run.id)).status
  assert.equal(st,'needs_input')          // 空正文重试后停下，草稿仍为空
  const again=wf.createRun(p.id,1)
  assert.equal(again.status,'needs_input','非 failed 的停住状态必须原样返回，不自动重跑')
  assert.equal(writes,2,'重跑不应发生（仍是首次那两次）')
})
