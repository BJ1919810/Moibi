import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChangeService } from '../server/change-request.js'
import { buildWriterPacket, findLeaks } from '../server/projection.js'
import { createWorkflow } from '../server/workflow.js'
import { emptyLedger } from '../server/schema.js'

const clone=structuredClone
const fresh=()=>({
  id:'p_test',headVersion:1,editRevision:0,schemaVersion:2,idea:'悬疑故事',title:'旧书名',genre:'悬疑',targetChapters:3,
  preferences:{},chapters:[{no:1,title:'开端',status:'committed',text:'旧名赵甲走入山谷。',summary:'第一章'}],
  entities:[{id:'ent_a',kind:'character',name:'赵甲',aliases:[],publicIdentity:'警员',publicRole:'主角',authorRole:'主角',secret:'暗藏的绝对真相123456789',characterCard:{personality:'理性'}}],
  outline:{title:'旧书名',theme:'旧主题',totalChapters:3,
    acts:[{name:'第一幕',summary:'起因'},{name:'第二幕',summary:'转折'},{name:'第三幕',summary:'结局'}],
    cast:[{entityId:'ent_a',name:'赵甲'}],foreshadows:[{id:'fs_a',seed:'一封信',payoff:'一封信揭示某某的真正死因'}],
    volumes:[{title:'第一卷',chapters:[
      {no:1,title:'开端',summary:'开端',cast:['ent_a'],foreshadows:[]},
      {no:2,title:'继续',summary:'继续调查',cast:['ent_a'],foreshadows:[{id:'fs_a',action:'plant'}]},
      {no:3,title:'收束',summary:'所有人回家',cast:['ent_a'],foreshadows:[]}
    ]}]},ledger:emptyLedger()
})

// 提供持久化的测试仓库，模拟重启后重新打开 JSON；比较写入由同步 CAS 保护。
function fixture(t) {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'mobi-change-'))
  t.after(()=>fs.rmSync(d,{recursive:true,force:true}))
  const pf=path.join(d,'project.json')
  fs.writeFileSync(pf,JSON.stringify(fresh()))
  const repo={
    getProject:()=>JSON.parse(fs.readFileSync(pf)),
    getChange:id=>{try{return JSON.parse(fs.readFileSync(path.join(d,id+'.json')))}catch{return null}},
    saveChange:c=>{fs.writeFileSync(path.join(d,c.id+'.json'),JSON.stringify(c));return c},
    listChanges:id=>fs.readdirSync(d).filter(f=>f.startsWith('cr_')).map(f=>JSON.parse(fs.readFileSync(path.join(d,f)))).filter(c=>c.projectId===id),
    commitProjectEdit(next,head,edit){
      const curr=repo.getProject()
      if (curr.headVersion!==head || curr.editRevision!==edit || next.editRevision!==edit+1) throw Error('冲突')
      fs.writeFileSync(pf,JSON.stringify(next))
      return next
    },
    listRuns:()=>[],
    saveRun:r=>r,
    getRun:()=>null,
  }
  return {repo,service:createChangeService(repo),pf}
}

test('创建草稿持久化且不写正式作品，影响分析包含真实出场章节',t=>{
  const {repo,service}=fixture(t)
  const request=service.create('p_test',{kind:'rename',entityId:'ent_a',value:'林川',expectedEditRevision:0})
  assert.equal(repo.getProject().entities[0].name,'赵甲')
  assert.deepEqual(request.impact.affectedChapters,[1,2,3])
  assert.equal(request.impact.risk,'medium')
  assert.equal(createChangeService(repo).get(request.id).change.value,'林川')
})

test('确认后 CAS 提交、稳定实体 ID、别名、历史正文和账本不变，重复确认幂等',t=>{
  const {repo,service}=fixture(t)
  const before=repo.getProject()
  const r=service.create('p_test',{kind:'rename',entityId:'ent_a',value:'林川'})
  const result=service.approve(r.id)
  assert.equal(result.request.status,'committed')
  const after=repo.getProject()
  assert.equal(after.entities[0].id,'ent_a')
  assert.deepEqual(after.entities[0].aliases,['赵甲'])
  assert.equal(after.entities[0].name,'林川')
  assert.equal(after.chapters[0].text,before.chapters[0].text)
  assert.deepEqual(after.ledger,before.ledger)
  assert.equal(after.editRevision,1)
  assert.equal(after.headVersion,1)
  assert.equal(after.editEvents[0].id,r.id)
  assert.equal(service.approve(r.id).project.editRevision,1)
  assert.equal(repo.listChanges('p_test').length,1)
})

test('过期请求失败且不覆盖新数据；拒绝的请求无法再批准',t=>{
  const {repo,service}=fixture(t)
  const a=service.create('p_test',{kind:'theme',value:'新的主题'})
  const b=service.create('p_test',{kind:'world',value:'世界规则由旧变新'})
  service.approve(a.id)
  assert.throws(()=>service.approve(b.id),/已变化/)
  assert.equal(service.get(b.id).status,'stale')
  assert.equal(repo.getProject().authorWorldRules,undefined)
  const c=service.create('p_test',{kind:'rename',entityId:'ent_a',value:'小林'})
  service.reject(c.id)
  assert.throws(()=>service.approve(c.id),/已处理/)
})

test('结构性修改设置重排门禁，但绝不删除历史正文与账本',t=>{
  const {repo,service}=fixture(t)
  const r=service.create('p_test',{kind:'foreshadow',foreshadowId:'fs_a',field:'payoff',value:'真正主谋是老师'})
  assert.equal(r.impact.risk,'high')
  const orig=clone(repo.getProject().chapters)
  service.approve(r.id)
  const p=repo.getProject()
  assert.equal(p.pendingReplan,true)
  assert.deepEqual(p.chapters,orig)
  assert.equal(p.outline.foreshadows[0].payoff,'真正主谋是老师')
  const workflow=createWorkflow({repo})
  assert.throws(()=>workflow.createRun('p_test',2),/先完成.*重排/)
})

test('单章指令只在未来章节生效，并遵循 WriterPacket 泄密门禁',t=>{
  const {repo,service}=fixture(t)
  assert.throws(()=>service.create('p_test',{kind:'chapter_intent',chapterNo:1,value:'增加紧迫感'}),/正式章节/)
  const r=service.create('p_test',{kind:'chapter_intent',chapterNo:2,value:'让人物用雨中的脚步声制造紧张气氛'})
  service.approve(r.id)
  const p=repo.getProject()
  assert.equal(p.pendingReplan,undefined)
  assert.equal(p.outline.volumes[0].chapters[1].authorInstruction,'让人物用雨中的脚步声制造紧张气氛')
  const packet=buildWriterPacket(p,2)
  assert.match(packet.task.summary,/雨中的脚步声/)
  assert.deepEqual(findLeaks(packet,p),[])
  // 用户输入中包含已定义的作者秘密，即使明确确认，也不能绕过投影。
  const secret=service.create('p_test',{kind:'chapter_intent',chapterNo:3,value:p.entities[0].secret})
  service.approve(secret.id)
  assert.ok(findLeaks(buildWriterPacket(repo.getProject(),3),repo.getProject()).length)
})

test('角色/三幕/世界观/主题/AI偏好均可安全应用；无效字段拒绝',t=>{
  const {repo,service}=fixture(t)
  for (const payload of [
    {kind:'character_field',entityId:'ent_a',field:'personality',value:'坚定'},
    {kind:'act',actIndex:1,value:'逆转'},
    {kind:'world',value:'所有角色不能使用魔法'},
    {kind:'preferences_bulk',values:{style:'短句为主',tone:'克制'}},
    {kind:'theme',value:'怀疑和理解的边界'},
  ]) service.approve(service.create('p_test',payload).id)
  const p=repo.getProject()
  assert.equal(p.entities[0].characterCard.personality,'坚定')
  assert.equal(p.outline.acts[1].summary,'逆转')
  assert.equal(p.authorWorldRules,'所有角色不能使用魔法')
  assert.equal(p.preferences.style,'短句为主')
  assert.equal(p.outline.theme,'怀疑和理解的边界')
  assert.equal(p.editRevision,5)
  assert.throws(()=>service.create('p_test',{kind:'character_field',entityId:'ent_a',field:'id',value:'evil'}),/不允许/)
  assert.throws(()=>service.create('p_test',{kind:'foreshadow',foreshadowId:'nope',field:'payoff',value:'x'}),/不存在/)
  assert.throws(()=>service.create('p_test',{kind:'theme',value:''}),/不能为空/)
  assert.throws(()=>service.create('p_test',{kind:'preferences_bulk',values:{admin:'yes'}}),/不允许/)
})

/* ------------------- `pendingReplan` 的置位判据（p1） ------------------- */
/**
 * `pendingReplan` 会把**后续所有正文生成全部拦下**（workflow.createRun），
 * 直到跑完一次 mode='full' 的重排才解锁。所以它的精确语义必须是
 * 「**真有未来章节计划需要重排**」——用 `affectedChapters.length > 0` 判据：
 *    · 无大纲（开书失败）⇒ 天然为 0
 *    · 有大纲但全已定稿 ⇒ 也是 0（没有**未来**章节）
 * 两种情况下改设定都只是「保存作者设定」，不该冻结作品。
 *
 * 真实踩坑（全量压测挖出）：曾经无条件置位 ⇒ 空作品上改世界观后被锁死，
 * 且唯一出路（重排）无章节可排、必然失败，界面上没有任何出路。
 */

// 把 fixture 的作品改成「无大纲」（开书失败后的壳）或「全部定稿」。
// 直接改写底稿，不经过 CAS（只是搭场景，不是被测行为）。
function variant(t, mutate) {
  const f = fixture(t)
  const next = mutate(clone(f.repo.getProject()))
  fs.writeFileSync(f.pf, JSON.stringify(next))
  return f
}

test('无大纲的空作品上改世界观：只保存作者设定，不置 pendingReplan（否则作品会被永久锁死）',t=>{
  const {repo,service}=variant(t, p=>{ p.outline=null; p.chapters=[]; return p })
  const r=service.create('p_test',{kind:'world',value:'所有能力都必须支付寿命'})
  // 影响分析本身仍是 high/需要重排（类型决定），但没有章节可受影响
  assert.equal(r.impact.risk,'high')
  assert.equal(r.impact.replan,true)
  assert.deepEqual(r.impact.affectedChapters,[])
  const p=service.approve(r.id).project
  // 设定真的存下来了
  assert.equal(p.authorWorldRules,'所有能力都必须支付寿命')
  // …但作品没有被冻结
  assert.equal(p.pendingReplan,undefined)
  // 如实记录了「本可重排但没有未来章节」，便于事后追查
  assert.equal(p.editEvents.at(-1).impact.replanSkipped,true)
  assert.deepEqual(p.editEvents.at(-1).impact.affectedChapters,[])
})

test('全部章节已定稿时改设定：没有未来计划要重排，不置 pendingReplan',t=>{
  const {repo,service}=variant(t, p=>{
    p.chapters=[{no:1,status:'committed',text:'a'},{no:2,status:'committed',text:'b'},{no:3,status:'committed',text:'c'}]
    return p
  })
  const r=service.create('p_test',{kind:'world',value:'世界规则更新'})
  assert.deepEqual(r.impact.affectedChapters,[])
  const p=service.approve(r.id).project
  assert.equal(p.pendingReplan,undefined)
  assert.equal(p.authorWorldRules,'世界规则更新')
})

test('仍有未定稿的后续章节时，改设定才置 pendingReplan（判据不能被放宽过头）',t=>{
  const {repo,service}=fixture(t) // fixture 里第 1 章已定稿，2/3 未定稿
  const r=service.create('p_test',{kind:'world',value:'世界规则更新'})
  assert.deepEqual(r.impact.affectedChapters,[2,3])
  const p=service.approve(r.id).project
  assert.equal(p.pendingReplan,true)
  // 并且真的会拦下后续生成
  assert.throws(()=>createWorkflow({repo}).createRun('p_test',2),/先完成.*重排/)
})

test('空作品上改设定后重新生成大纲，能靠「重新生成」自己解锁（清历史遗留的 pendingReplan）',async t=>{
  // 手工造出「历史遗留脏标志」：模拟旧版本代码留下的 pendingReplan
  const f=variant(t, p=>{ p.outline=null; p.chapters=[]; p.pendingReplan=true; return p })
  const { repo } = f
  const { createApiRouter } = await import('../server/api-router.js')
  const router=createApiRouter({
    store:{ ...repo, publicConfig:()=>({hasKey:false}), saveProject:p=>repo.commitProjectEdit(p,repo.getProject().headVersion,repo.getProject().editRevision) },
    pipeline:{
      // 真的产出一卷大纲（对应「重新生成成功」）
      generateOutline:async (p)=>{ p.outline={title:'新书',volumes:[{title:'第一卷',chapters:[{no:1,title:'开端'}]}]} },
      fillMissingSettings:async ()=>({skipped:true,filled:[]}),
      missingSettingFields:()=>[],
    },
    workflow:{}, replanner:{}, assistant:{}, changes:{},
    testConnection:async()=>({ok:true}), validateChapterCount:n=>Number(n)||30, normalizeGenreTags:()=>[],
  })
  const res=await router({ path:'/api/projects/p_test/outline', method:'POST', body:{} })
  assert.equal(res.status,200)
  assert.equal(res.data.project.pendingReplan,false)
  assert.equal(res.data.project.replanClearedReason,'outline-regenerated')
  // 解锁后真的能写正文了
  assert.doesNotThrow(()=>createWorkflow({repo}).createRun('p_test',1,{autoCommit:false})
    ,'清掉 pendingReplan 后应能正常创建生成任务')
})

test('重新生成大纲但没产出任何卷时，不得误清 pendingReplan（大纲为空≠大纲已更新）',async t=>{
  const f=variant(t, p=>{ p.outline=null; p.chapters=[]; p.pendingReplan=true; return p })
  const { repo } = f
  const { createApiRouter } = await import('../server/api-router.js')
  const router=createApiRouter({
    store:{ ...repo, publicConfig:()=>({hasKey:false}), saveProject:p=>repo.commitProjectEdit(p,repo.getProject().headVersion,repo.getProject().editRevision) },
    pipeline:{
      generateOutline:async ()=>{}, // 不 throw，但也不产出 —— 「大纲为空也返回 201」那个坑
      fillMissingSettings:async ()=>({skipped:true,filled:[]}),
      missingSettingFields:()=>[],
    },
    workflow:{}, replanner:{}, assistant:{}, changes:{},
    testConnection:async()=>({ok:true}), validateChapterCount:n=>Number(n)||30, normalizeGenreTags:()=>[],
  })
  const res=await router({ path:'/api/projects/p_test/outline', method:'POST', body:{} })
  assert.equal(res.status,200)
  // 没有任何卷 ⇒ 什么都没变，标志必须原样保留
  assert.equal(repo.getProject().pendingReplan,true)
  assert.equal(repo.getProject().replanClearedReason,undefined)
})

