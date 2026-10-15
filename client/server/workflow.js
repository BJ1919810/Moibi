/**
 * R4 可恢复单章任务（模块化单体版）。
 * 关键纪律：所有模型产物先写 run 草稿；正式 project 在最后一次性快照更新。
 * 客户端断线不会中断服务端任务；重启后的不确定外部调用不自动重发避免双重计费。
 */
import crypto from 'node:crypto'
import { compileChapterContext } from './context-compiler.js'
import { buildWriterMessages, findChapterMeta, renderWriterPacket, collectContextNotes } from './projection.js'
import { safePlanMessages, applySafePlan } from './dynamic-plan.js'
import { estimateTokens } from './context-compiler.js'
import { extractMessages } from './prompts.js'
import { applyExtraction, makeNameResolver, applyLearnedAliases, evidenceCore, isSpecificEvidence, locateEvidence } from './ledger.js'
import { recordForeshadowEvidence, recordEntityRevealEvidence, allowedForeshadowActions } from './foreshadow.js'
import { contentFingerprint, validateProject, stripChapterTitlePrefix, stripFence, cleanBody } from './schema.js'
import { calculateCost, assertCostBudget, usageSummary } from './cost.js'
import { chat } from './providers/openai.js'
import * as defaultRepo from './store.js'
// 并发互斥的判据只有一份（server/run-status.js）—— 别再在这里抄一份状态列表
import { findBlockingRun, RESUMABLE_RUN_STATUSES } from './run-status.js'
// `chapterRisk` 的词表与改名原因见 chapter-planner.js
import { CHAPTER_RISK } from './chapter-planner.js'

const copy = (v) => structuredClone(v)
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24)
// ⛔ 这里原来有一份**内联的** `stripFence`（与 pipeline.js 各一份）。剥围栏/清正文都收进了
//    `schema.js`（唯一实现）—— 顺带修掉一个真 bug：活路径原来只剥围栏，**不剥**模型爱加的开头
//    （「第一章 …」「以下是正文：」「---」），而那些东西一旦落进 chapters[].text 就洗不掉了。
const isEmptyModelError = (err) => /模型只产出了思考内容|模型返回内容为空|正文为空/.test(String(err?.message || err))
function parseExtraction(text) {
  const e = JSON.parse(stripFence(text))
  if (!e || typeof e !== 'object' || typeof e.summary !== 'string' || !e.summary.trim()) throw new Error('记忆抽取缺少有效摘要')
  for (const k of ['facts', 'states', 'knowledge', 'threads', 'resolved', 'foreshadows', 'reveals']) {
    if (e[k] == null) e[k] = []
    if (!Array.isArray(e[k])) throw new Error(`记忆抽取 ${k} 不是数组`)
  }
  return e
}

/**
 * 纯函数：工作副本上先完成所有验证和状态变更，再返回新的项目快照。
 * 调用方必须在写磁盘前重新比较 expectedHeadVersion，防止旧任务覆盖新状态。
 */
export function commitDraft(project, draft, expectedHeadVersion, expectedEditRevision = null) {
  if (expectedEditRevision != null && Number(project.editRevision || 0) !== Number(expectedEditRevision)) throw new Error('规划修订版本冲突，草稿须重新编译')
  if (Number(project.headVersion || 0) !== Number(expectedHeadVersion)) throw new Error('项目版本冲突：当前 head 已变化')
  if ((project.chapters || []).some((ch) => ch.no === draft.no && ch.status === 'committed')) throw new Error('本章已经正式提交，禁止重复提交')
  const nextNo = Math.max(0, ...(project.chapters || []).filter((x) => x.status === 'committed').map((x) => x.no)) + 1
  if (draft.no !== nextNo) throw new Error(`只能顺序提交章节，期待第 ${nextNo} 章`)
  if (!draft.extractOk || !draft.extracted) throw new Error('记忆抽取未完成，不允许提交正式剧情')
  if (!String(draft.text || '').trim()) throw new Error('正文未完成，不允许提交')
  const e = draft.extracted
  if (!e || typeof e.summary !== 'string' || !e.summary.trim()) throw new Error('记忆抽取无有效摘要')
  for (const key of ['facts', 'states', 'knowledge', 'threads', 'resolved']) if (e[key] != null && !Array.isArray(e[key])) throw new Error(`记忆抽取字段 ${key} 无效`)
  // 位置、物品和角色认知会直接影响下一章；必须保留可核对的正文证据。
  // ⚠️ 中文对白型证据天然短（“不是。”仅 3 字）：旧的「≥4 字符」是英文思维，会把真实
  // 且可精确定位的证据误杀。改为「去标点后 ≥2 个实义字」，且仍必须在正文中原样出现。
  //
  // ⚠️ 主体名解析必须**和落账时用同一个解析器**（带本章正文上下文、能认「遥学姐」这类称呼）。
  // 否则会出现最荒谬的一种失败：门禁说「主体无法解析到实体」直接拒稿，
  // 而落账逻辑其实认得出来 —— 用户看到的是「正文写完了但永远提交不了」。
  // 解析器不原地改 project；学到的新称呼收集在 resolved.learned 里，只在提交成功时落盘。
  const resolved = makeNameResolver(project, { text: draft.text })
  const resolveName = resolved
  const evidenceItems = [
    ...(e.states || []).map((item, i) => ({ kind: 'states', i, item })),
    ...(e.knowledge || []).map((item, i) => ({ kind: 'knowledge', i, item })),
  ]
  const unresolvedSubjects = []
  const unverifiedEvidence = []
  const dropIdx = { states: new Set(), knowledge: new Set() }
  for (const { kind, i, item } of evidenceItems) {
    const evidence = typeof item?.evidence === 'string' ? item.evidence.trim() : ''
    // 证据必须真的在正文里 —— `locateEvidence` 容忍模型表达引用时的格式偏差
    // （外层引号 / 省略号拼接 / 隔着插叙），但内容必须逐字可查，编造的过不了。
    const hit = locateEvidence(draft.text, evidence)
    if (!evidence || !isSpecificEvidence(evidence) || !hit) {
      const who = String(item?.subject || item?.character || '未署名')
      const what = String(item?.value || item?.fact || '').slice(0, 40)
      const reason = !evidence ? '未给出证据'
        : !isSpecificEvidence(evidence) ? `证据仅 ${evidenceCore(evidence).length} 个实义字`
          : '证据未在本章正文中原样出现'
      unverifiedEvidence.push(`${kind}#${i} ${who}${what ? ` · ${what}` : ''}：${reason}${evidence ? `；evidence=“${evidence}”` : ''}`)
      dropIdx[kind].add(i)
      continue
    }
    // 证据齐了再看主体能不能落到实体上。落不到的**不阻断整章**（详见下方说明）。
    const named = kind === 'knowledge'
      ? item?.characterId ?? item?.character ?? item?.subjectId ?? item?.subject
      : item?.subjectId ?? item?.subject ?? item?.character
    if (!named || !resolveName(named)) {
      unresolvedSubjects.push(`${kind}#${i}「${String(named || '(空)').slice(0, 20)}」`)
    }
  }
  /**
   * 证据无法核实 ⇒ **只丢这一条，不废整章**。
   *
   * 判据与 `state-engine.js` 的 VIOLATION 分级完全一致（「这条坏数据会不会污染别处」）：
   * 某条变化拿不到可核实的正文证据，**只影响它自己** ⇒ 不把它交给账本即可，
   * 整章其余内容完全正常。所以它应当是 **warning 级（跳过该条）**，而不是 error 级（整批拒）。
   *
   * 真实踩坑（v2.0.0 全量压测，连续三章）：第 1 章 2584 字、第 2 章 2624 字、第 3 章 2298 字
   *   **均已付费**，却各自因为 7 条 / 6 条 / 1 条证据的「引用格式」问题被**整章拒稿**，
   *   正文永远提交不进去 —— 而逐条核对后，这些证据的内容**全都在正文里**，没有一条是编造。
   *   第 3 章那条更极端：模型引用了一句只有一个字的对白 `“你。”`（实义字 1 个，低于门槛），
   *   这类**无法靠更聪明的匹配解决**，只能按「跳过该条」处理。
   *
   * 安全性与「整章拒稿」等价：未核实的变化**不会进账本**（下面会把它从 e 里剔除），
   * 所以「编造的状态变化污染长期记忆」这个风险并没有变大 —— 只是不再连带毁掉整章正文。
   */
  if (unverifiedEvidence.length) {
    console.warn(`[第 ${draft.no} 章 · 提交] 以下变化因证据无法核实，已跳过不入账（本章照常提交）：${unverifiedEvidence.join('、')}`)
  }
  // 主体解析不到实体时的取舍（真实踩过：整章卡死在「遥学姐」「部室柜子」上）：
  //   门禁原本是「有任何一个解析不到就拒绝整章提交」，导致正文写好却永远提交不进去，
  //   而那两个变化本身在正文里有完整证据。
  //   现在的规则是：**证据本身必须逐字可查（仍然硬拦）**，主体解析不到的只是
  //   该条变化不入账（state-engine 已按 warning 级跳过），本章照常提交，
  //   并且把这些条目写进 run.unresolvedSubjects 让作者看得见。
  if (unresolvedSubjects.length) {
    console.warn(`[第 ${draft.no} 章 · 提交] 以下变化的主体无法解析到实体，已跳过不入账：${unresolvedSubjects.join('、')}`)
  }
  const result = copy(project)
  // 学到的称呼落到**副本**上（正式对象在拒绝路径上必须一字未改）
  applyLearnedAliases(result, resolved.learned)
  const sourceVersion = Number(expectedHeadVersion) + 1
  const batchKey = `ch${draft.no}:${contentFingerprint(draft.text)}`
  // 只把**证据可核实**的条目交给账本；被剔除的条目不进长期记忆。
  const eVerified = {
    ...e,
    states: (e.states || []).filter((_, i) => !dropIdx.states.has(i)),
    knowledge: (e.knowledge || []).filter((_, i) => !dropIdx.knowledge.has(i)),
  }
  const applied = applyExtraction(result, eVerified, { chapterNo: draft.no, resolveName, sourceVersion, batchKey, evidenceText: draft.text })
  // 状态引擎的 error 级违规（形状损坏、时间回退）仍然整批拒绝 —— 那是真损坏。
  // 但 **warning 级不再阻断提交**：它的语义就是「这一条候选变化被跳过，其余照常」
  // （见 state-engine.js 的 VIOLATION 表）。旧的 `|| applied.violations?.length`
  // 把 warning 也当成拒稿理由，等于把「跳过一条」升级成「整章作废」，
  // 结果就是正文写完了却永远提交不进去。被跳过的条目现在落到 unresolvedSubjects。
  if (applied.rejected || applied.transitionOk === false) {
    throw new Error(`非法状态转移：${applied.violations?.map((x) => x.message).join('、') || '未知原因'}`)
  }
  const skipped = (applied.violations || []).filter((v) => v.severity !== 'error')
  if (skipped.length) console.warn(`[第 ${draft.no} 章 · 落账] 跳过 ${skipped.length} 条候选变化：${skipped.map((v) => v.message).join('、')}`)
  const meta = findChapterMeta(result.outline, draft.no)
  if (!meta) throw new Error('无法找到本章的规划引用')
  const chapter = { no: draft.no, title: stripChapterTitlePrefix(draft.title || meta.title || ''), volumeTitle: draft.volumeTitle || meta.volumeTitle || '',
    text: draft.text, summary: e.summary, extracted: e, applied, extractOk: true,
    wordCount: String(draft.text).replace(/\s/g, '').length, status: 'committed',
    sourceVersion, contentHash: contentFingerprint(draft.text), packetSchemaVersion: draft.packetSchemaVersion || 2,
    contextManifest: draft.contextManifest || null, createdAt: new Date().toISOString() }
  // ⛔ 投影诊断必须落在**活路径**上：`collectContextNotes` 原先只在死代码 `pipeline.generateChapter()`
  //    里被调用 ⇒ `chapter.contextNotes` 实测 0/25 章 ⇒ 大纲页的「投影诊断」标记永不出现。
  //    诊断来自 `run.manifest`（隔离/剔除/截断）—— 投影层真实发生的取舍。
  //    ⚠️ `commitDraft` 是纯函数，拿不到 `run`：调用方把 manifest 放在 `draft.contextManifest` 里传进来。
  chapter.contextNotes = collectContextNotes(draft.no, draft.contextManifest)
  // ⛔ 开书路径**丢掉的角色名必须被看见**：原来是静默丢弃（`filter(Boolean)` 之后什么都不剩）。
  //    `castUnresolved` 由 `normalizeOutline` 记在章节计划上，这里用**现成的 contextNotes 通道**
  //    把它变成大纲页章节行上的标记 —— 不新开一套提示机制。
  if (meta?.castUnresolved?.length) {
    chapter.contextNotes.push(`出场名单里有 ${meta.castUnresolved.length} 个名字没认出来（已忽略）：${meta.castUnresolved.slice(0, 3).join('、')}`)
  }
  // 实际铺设/回收由证据事件决定；只有正文中出现对应原文才被接受。
  chapter.foreshadowReview = recordForeshadowEvidence(result, chapter, e.foreshadows || [], { sourceVersion, extractOk: true })
  chapter.entityRevealReview = recordEntityRevealEvidence(result, chapter, e.reveals || [], { sourceVersion })
  const expectedPayoffs = (meta.foreshadows || []).filter((x) => x.action === 'pay_off' && x.approved === true)
  for (const directive of expectedPayoffs) {
    if (!chapter.foreshadowReview.accepted.some((x) => x.foreshadowId === directive.id && x.action === 'pay_off')) {
      throw new Error(`计划回收的伏笔 ${directive.id} 缺乏正文证据，不能确认提交`)
    }
  }
  if ((meta.reveals || []).some((r) => r.approved && !chapter.entityRevealReview.accepted.some((x) => x.entityId === r.entityId))) {
    throw new Error('计划揭示的角色秘密缺乏正文证据，不能确认提交')
  }
  result.chapters = [...(result.chapters || []), chapter].sort((a, b) => a.no - b.no)
  result.headVersion = sourceVersion
  const issues = validateProject(result)
  if (issues.length) throw new Error(`正式项目结构校验未通过：${issues.slice(0, 3).join('；')}`)
  return { project: result, chapter,
    // 让「有变化没入账」这件事在界面上可见，而不是只留在服务端日志里。
    unresolvedSubjects: [
      ...unresolvedSubjects,
      ...unverifiedEvidence.map((x) => `证据无法核实，未入账：${x}`),
      ...skipped.map((v) => v.message),
    ] }
}

/** 创建具有可替换仓储/模型的工作流；业务测试不需要真正请求模型。 */
export function createWorkflow({ repo = defaultRepo, model = chat, config = defaultRepo.getConfig } = {}) {
  const active = new Set()
  const getRun = (id) => repo.getRun(id)
  const save = (run) => { run.updatedAt = new Date().toISOString(); repo.saveRun(run); return run }
  function createRun(projectId, chapterNo, { requestKey = null, expectedHeadVersion = null, autoCommit = true } = {}) {
    const project = repo.getProject(projectId)
    if (!project) throw new Error('作品不存在')
    if (project.pendingReplan) throw new Error('作品设定已变化，请先完成未写章节重排后再生成正文')
    const no = Number(chapterNo)
    if (!Number.isInteger(no) || no < 1) throw new Error('章号无效')
    /**
     * 章号必须落在**作品规划范围内**。
     *
     * 真实踩坑（全量压测「胡来」用例）：请求第 9999 章时，
     * 原实现只检查 `meta?.pendingDetail` —— 而 `findChapterMeta` 对越界章号返回 `null`，
     * `null?.pendingDetail` 是 `undefined`（假）⇒ **检查静默通过**，
     * 于是建出一个注定失败的任务（返回 202，随后才报「找不到第 9999 章规划」）。
     * 用户看到的是「点了一下没反应，多出一条失败任务」，而不是当场被拒绝。
     * ⚠️ `?.` 只对「拿到对象但属性缺失」有效，对「对象本身是 null」会假通过 —— 必须显式判空。
     */
    const meta = findChapterMeta(project.outline, no)
    if (!meta) {
      const total = (project.outline?.volumes || []).flatMap((v) => v.chapters || []).length
      throw new Error(`第 ${no} 章不在作品规划范围内（当前规划 ${total} 章）`)
    }
    if (meta.pendingDetail) throw new Error('本章仍是未细化的占位计划；请先在目录细化下一组章节')
    const head = Number(project.headVersion || 0)
    if (expectedHeadVersion != null && Number(expectedHeadVersion) !== head) throw new Error('项目版本冲突')
    if ((project.chapters || []).some((ch) => ch.no === no && ch.status === 'committed')) throw new Error('本章已经提交')
    const editRevision = Number(project.editRevision || 0)
    const key = String(requestKey || `chapter-${no}-head-${head}-edit-${editRevision}`)
    const id = `run_${hash(`${projectId}|${key}`)}`
    const existing = getRun(id)
    if (existing) {
      /**
       * ⛔⛔ 确定性 run id ⇒ 一次失败会把这一章**永久钉死**。
       *
       * id 只由 `projectId|chapter-N-head-H-edit-E` 决定，只要没写进新章、没改设定，
       * 同一章的 id 就不变；命中旧 run 就**原样返回**，而路由只在 `status === 'queued'`
       * 时才 `process()` ⇒ 用户再点「生成本章」只会看到上次那条报错，**什么都不会发生**。
       *
       * 真实踩坑（v2.0.0 全量 30 章压测第 18–25 章）：DeepSeek 网关抖动返回 `fetch failed`，
       * 这 8 章就此再也写不出来 —— 重跑压测时它们连一次模型调用都没发生，
       * 直接返回 41 分钟前的旧错误（时间戳可见）。与 `replan.create()` 是同一个坑（那边已修）。
       *
       * ⚠️ **只重置 `failed`**。按 `process()` 的 catch 分支：
       *   `run.status = run.draft?.text ? 'needs_input' : 'failed'`
       * ⇒ `failed` 严格等价于「**没有草稿、一分钱没花**」，重跑是安全的。
       * `needs_input` / `awaiting_acceptance` 手里握着**已付费草稿**，绝不能在这里自动重跑
       * （会二次扣费）；它们的正路是 `resume()`（¥0 重试提交，见 resume 的护栏注释）。
       */
      if (existing.status === 'failed') {
        existing.status = 'queued'; existing.step = 'queued'
        delete existing.error
        return save(existing)
      }
      return existing
    }
    // 同项目禁止并行模型请求，避免不同设备同时消耗并覆盖同一作品。
    //
    // ⚠️ 豁免集合必须包含**所有「已经停住、不会再自己跑」的状态**：
    //   · committed / failed / cancelled / stale —— 原始四个终态
    //   · needs_input —— 它也是「停住等人工」，但曾经不在豁免名单里，
    //     于是**永久锁死整个作品**：第 2 章卡在 needs_input 后，
    //     用户想写第 3 章也会被这句拦下，而界面上唯一的出路（点「恢复」）
    //     又因为另一条护栏而无反应（见 resume()）。两头堵死。
    //     注意它锁的是**整个作品**，而 run 是**单章**的 —— 代价完全不成比例。
    //   `awaiting_acceptance` **故意不豁免**：那是在等作者确认本章，
    //   此时并行开新章会让「确认」指向一个已经变化的项目版本。
    if (findBlockingRun((repo.listRuns?.(projectId) || []).filter((r) => r.projectId === projectId))) {
      throw new Error('该作品已有未完成的生成任务，请恢复或取消现有任务')
    }
    return save({ id, projectId, chapterNo: no, requestKey: key, baseHeadVersion: head,
      autoCommit, baseEditRevision: editRevision, status: 'queued', step: 'queued', draft: null, plan: null, manifest: null,
      usage: [], error: null, createdAt: new Date().toISOString() })
  }
  async function process(id) {
    if (active.has(id)) return getRun(id)
    const starting = getRun(id)
    if (!starting) throw new Error('任务不存在')
    if (['committed','cancelled','stale'].includes(starting.status)) return starting
    if (['writing','extracting'].includes(starting.status) || (starting.status === 'planning' && starting.step === 'l2-call')) {
      // 这是进程重启留下的中途调用，供应商是否扣费未知，不能自动重发。
      return save({ ...starting, status: 'needs_input', error: '上次模型调用结果未能确认；请人工选择恢复以避免重复扣费' })
    }
    active.add(id)
    try {
      let run = getRun(id)
      const baseline = repo.getProject(run.projectId)
      if (!baseline || Number(baseline.headVersion || 0) !== run.baseHeadVersion || Number(baseline.editRevision || 0) !== Number(run.baseEditRevision || 0)) return save({ ...run, status: 'stale', error: '基础版本已过期，停止提交' })
      const cfg = config()
      const rates = cfg.pricing || null
      const beforeCall = (promptText, maxTokens) => {
        const used = calculateCost(run.usage, rates)
        const possible = calculateCost([{ inputTokens: Math.ceil(promptText.length), outputTokens: maxTokens }], rates)
        if (used != null && possible != null) assertCostBudget(used, possible, cfg.chapterBudget)
        if (cfg.maxChapterTokens && run.usage.reduce((a, u) => a + u.inputTokens + u.outputTokens, 0) + Math.ceil(promptText.length) + maxTokens > cfg.maxChapterTokens) throw new Error('本章 token 预算不足')
      }
      if (!run.draft?.text) {
        run.status = 'planning'; run.step = 'planning'; save(run)
        const reserve = Math.max(0, Number(cfg.contextWindow || 0) - 6144 - 512)
        const inputBudget = Number(cfg.contextWindow) > 0 ? Math.min(Number(cfg.inputBudget || 10000), reserve) : Number(cfg.inputBudget || 10000)
        const compiled = compileChapterContext(baseline, run.chapterNo, { inputBudget })
        let writerPacket = compiled.packet
        const cachedWriterTask = run.plan?.writerTask?.generatedBy === 'public-context-l2' ? run.plan.writerTask : null
        run.plan = { ...compiled.plan, writerTask: cachedWriterTask || compiled.plan.writerTask }
        run.manifest = compiled.manifest
        run.context = compiled.prompt
        save(run)
        // L2 只在未经作者批准的章节任务上调用。输入使用已投影的 WriterPacket，
        // 不给规划器高权限作者秘密；短 JSON 方案可复用，下次抽取失败不会重做规划。
        if (!compiled.plan.writerTask.approved) {
          // 已成功落盘的 L2 计划可以在正文超时后复用，避免重复支付规划费用。
          const completedL2 = run.plan?.writerTask?.generatedBy === 'public-context-l2'
            ? run.plan.writerTask : null
          let proposed = completedL2
          if (!proposed) {
            const l2Messages = safePlanMessages(writerPacket)
            beforeCall(JSON.stringify(l2Messages), 480)
            run.step = 'l2-call'; run.status = 'planning'; save(run)
            const l2 = await model({ ...cfg, messages: l2Messages, temperature: .35,
              maxTokens: 480, jsonMode: true, thinking: false, retries: 0 })
            if (getRun(id).status === 'cancelled') return getRun(id)
            run.usage.push({ ...(l2.usage || {}), step: 'planning' })
            if (l2.finishReason === 'length') throw new Error('L2 规划输出截断')
            proposed = JSON.parse(stripFence(l2.text))
          }
          writerPacket = applySafePlan(writerPacket, baseline, proposed)
          run.plan.writerTask = { summary: writerPacket.task.summary, goal: writerPacket.task.goal,
            approved: false, generatedBy: 'public-context-l2' }
          run.context = renderWriterPacket(writerPacket)
          run.manifest.packetHash = crypto.createHash('sha256').update(run.context).digest('hex')
          run.manifest.estimatedInputTokens = estimateTokens(run.context)
          if (run.manifest.estimatedInputTokens > inputBudget) throw new Error('L2 规划后正文上下文超预算')
          save(run)
        }
        const messages = buildWriterMessages(writerPacket)
        // 不确定的供应商失败不重发；只对有明确证据的空正文，最多额外请求一次，关闭 thinking。
        // 首次空响应 usage 保存在 run；重试标记先落盘，进程重启也不会自动双重扣费。
        const writeOnce = async (thinking, step) => {
          beforeCall(JSON.stringify(messages), 6144)
          run.status = 'writing'; run.step = step; save(run)
          try {
            const response = await model({ ...cfg, messages, temperature: .92, maxTokens: 6144, thinking, retries: 0 })
            if (getRun(id).status === 'cancelled') return { cancelled: true }
            run.usage.push({ ...(response.usage || {}), step })
            save(run)
            return { response, text: cleanBody(response.text) }
          } catch (err) {
            if (!isEmptyModelError(err)) throw err
            if (err.usage) run.usage.push({ ...err.usage, step })
            save(run)
            return { response: { finishReason: 'empty', emptyError: String(err.message) }, text: '' }
          }
        }
        let writing = await writeOnce(cfg.thinking === true, 'writing')
        if (writing.cancelled) return getRun(id)
        if (!writing.text && !run.emptyBodyRetryUsed) {
          run.emptyBodyRetryUsed = true
          run.emptyBodyRetryReason = '首次正文为空，第二次关闭深度思考'
          save(run)
          writing = await writeOnce(false, 'writing-no-thinking-retry')
          if (writing.cancelled) return getRun(id)
        }
        const meta = findChapterMeta(baseline.outline, run.chapterNo)
        run.draft = { no: run.chapterNo, title: meta.title, volumeTitle: meta.volumeTitle,
          text: writing.text, extractOk: false, extracted: null, packetSchemaVersion: compiled.packet.schemaVersion, contextManifest: run.manifest }
        run.step = 'written'; run.status = 'reviewing'; save(run)
        if (!writing.text || writing.response.finishReason === 'length') {
          run.status = 'needs_input'; run.error = !writing.text
            ? '正文连续为空；已最多关闭深度思考重试一次，不会自动再请求。请检查模型或手动恢复。'
            : '正文达到模型输出上限，请先人工检查草稿'
          return save(run)
        }
      }
      run = getRun(id)
      if (run.status === 'cancelled') return run
      if (!run.draft.extractOk) {
        // 必须把伏笔清单与本章允许的动作交给抽取模型，否则它无从知道 f1~f5 存在，
        // `foreshadows` 恒为空 ⇒ 伏笔铺设永远不会入账 ⇒ 回收章永久卡死（见 prompts.js 注释）。
        // pay_off 只有在**作者已授权**时才允许模型输出；未授权的一律不列出，避免模型空转。
        const fsCatalog = (baseline.outline?.foreshadows || []).map((f) => ({
          id: f.id, seed: f.seed, plantChapter: f.plantChapter, payoffChapter: f.payoffChapter,
        }))
        // ⛔ 这里曾经**单独**判了一次 `a.approved === true`，与 `revealDecision()` 的判据漂移：
        //    作者在伏笔面板授权回收（`safeReveal`）之后，正文**写得出来**，但抽取允许清单里
        //    没有 pay_off ⇒ 回收事件永远不入账 ⇒ 生命周期停在 reinforced、`doneForeshadows` 恒空、
        //    `readerKnown` 拿不到已授权文本。实证：3 本真实作品 50 章，`pay_off` 事件数 = 0。
        //    修法：判据只留一处（`foreshadow.allowedForeshadowActions`）。
        const fsAllowed = allowedForeshadowActions(baseline, run.chapterNo)
        // 把「已有线索」两个清单交给模型：只问「新埋」不问「了结」是线索无限膨胀的根因
        // （实测 25 章 82 条线索全 open、resolved 只产出 1 条）。见 prompts.js 注释。
        const thAll = (baseline.ledger?.plotThreads || [])
        const openThreads = thAll.filter((t) => t.status === 'open').map((t) => t.text).filter(Boolean)
        const closedThreads = thAll
          .filter((t) => t.status === 'paid_off' || t.status === 'abandoned')
          .map((t) => t.text).filter(Boolean)
        const messages = extractMessages(run.draft.text, run.chapterNo,
          { foreshadows: fsCatalog, plannedActions: fsAllowed, existingThreads: openThreads, closedThreads })
        beforeCall(JSON.stringify(messages), 2000)
        run.status = 'extracting'; run.step = 'extracting'; save(run)
        const response = await model({ ...cfg, messages, temperature: .2, maxTokens: 2000,
          jsonMode: true, thinking: false, retries: 0 })
        if (getRun(id).status === 'cancelled') return getRun(id)
        run.usage.push({ ...(response.usage || {}), step: 'extracting' })
        if (response.finishReason === 'length') throw new Error('记忆抽取被输出上限截断，拒绝提交')
        run.draft.extracted = parseExtraction(response.text)
        run.draft.extractOk = true
        run.step = 'extracted'; save(run)
      }
      run = getRun(id)
      if (run.status === 'cancelled') return run
      run.cost = usageSummary(run.usage, rates)
      // ⚠️ `chapterRisk` 原来叫 `plan.risk`，与 `change-impact` 的 `impact.risk`（作者改动风险）同名，
      //    而两边都用字面量 'high' ⇒ 读代码的人分不清。已改名；旧的 run 文件里仍是 `risk`，故兼容读。
      if (!run.autoCommit || (run.plan?.chapterRisk ?? run.plan?.risk) === CHAPTER_RISK.HIGH) {
        run.status = 'awaiting_acceptance'; run.step = 'approval'; return save(run)
      }
      return accept(id)
    } catch (err) {
      const run = getRun(id)
      // 用户已经取消的任务不能被迟到的 API 异常覆盖成可恢复状态。
      // 取消在独立请求中写盘；异常处理必须以最新持久化 run 为准。
      if (run.status === 'cancelled') return run
      run.status = run.draft?.text ? 'needs_input' : 'failed'
      run.error = String(err?.message || err)
      run.step = 'failed'
      return save(run)
    } finally { active.delete(id) }
  }
  async function accept(id) {
    const run = getRun(id)
    if (run?.status === 'committed') return run
    if (!run || !run.draft?.extractOk) throw new Error('尚无可以提交的完整草稿')
    if (run.status === 'cancelled') throw new Error('已取消的任务不能提交')
    const project = repo.getProject(run.projectId)
    if (!project) throw new Error('作品不存在')
    try {
      const output = commitDraft(project, run.draft, run.baseHeadVersion, run.baseEditRevision)
      if (repo.commitProjectVersion) repo.commitProjectVersion(output.project, run.baseHeadVersion, run.baseEditRevision)
      else {
        const check = repo.getProject(run.projectId)
        if (Number(check?.headVersion || 0) !== run.baseHeadVersion || Number(check?.editRevision || 0) !== Number(run.baseEditRevision || 0)) throw new Error('项目版本冲突')
        repo.saveProject(output.project)
      }
      run.status = 'committed'; run.step = 'committed'; run.chapter = { no: output.chapter.no, title: output.chapter.title }
      if (output.unresolvedSubjects?.length) run.unresolvedSubjects = output.unresolvedSubjects
      run.cost = usageSummary(run.usage, config().pricing || null)
      return save(run)
    } catch (e) {
      run.status = 'needs_input'; run.error = String(e.message || e)
      save(run)
      throw e
    }
  }
  async function resume(id) {
    const run = getRun(id)
    if (!run) throw new Error('任务不存在')
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) throw new Error('该任务当前状态不能恢复')
    /**
     * 草稿已生成 + 记忆已抽取 ⇒ 失败发生在「提交门禁」这一步。
     *
     * 历史实现这里**直接 throw**，理由是「重试只会撞同一条 throw，是死循环」。
     * 那个理由在当时成立，但它有个致命前提：**门禁规则会变，而护栏不会**。
     *
     * 真实事故（run_c8e0be16fa8cb747837a7698）：第 2 章 2353 字正文已生成、钱已花掉，
     * 因为旧门禁把「提取残缺」（模型写出 {subject:'部室柜子'} 却没给属性名）
     * 当成 error 而整章作废。修复门禁后，这条护栏仍然把它挡在门外 ——
     * 用户点「恢复」只看到同一句"请改用重新生成"，而界面上**根本没有那个入口**。
     * 结果：正文永远取不出来，作品被永久锁死。
     *
     * 现在的规则：**先真的试一次提交**。提交是纯函数 + CAS，幂等且**不调模型、不花钱**。
     * 成功就落盘；确实仍失败才把那次失败如实报出来。护栏从"预判"变成"实测"。
     */
    if (run.draft?.text && run.draft.extractOk) {
      try {
        return await accept(id)
      } catch (e) {
        throw new Error(`本章正文与记忆抽取已完成，但提交门禁仍未通过：${e?.message || e}`
          + '（已尝试直接重新提交，未重复调用模型、未产生费用）')
      }
    }
    // 显式恢复，允许人工确认是否承担一次不确定请求的重新费用。
    run.status = 'queued'; run.error = null; save(run)
    return process(id)
  }
  function cancel(id) {
    const run = getRun(id)
    if (!run) throw new Error('任务不存在')
    if (run.status === 'committed') throw new Error('正式提交的任务不能取消')
    run.status = 'cancelled'; run.step = 'cancelled'; return save(run)
  }
  return { createRun, getRun, process, resume, cancel, accept, listRuns: (id) => repo.listRuns?.(id) || [] }
}
