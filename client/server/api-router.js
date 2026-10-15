/**
 * 传输无关的 API 路由层。
 *
 * 设计动机：墨笔有两种运行形态 ——
 *   ① **桌面服务**：`index.js` 起 HTTP 服务，前端通过 fetch('/api/...') 访问；
 *   ② **App 内独立**：后端逻辑整体编进 App，前端**直接调用**本模块，不经网络。
 * 若把路由逻辑留在 index.js 里，②就得复制一份，两边必然逐渐漂移。
 *
 * ⇒ 把「参数 → 结果」的纯逻辑收在这里：
 *     入参 = { path, method, query, body }
 *     出参 = { status, data }（导出接口返回 { status, file }）
 *   index.js 只负责「读 HTTP 请求 → 调这里 → 写 HTTP 响应」；
 *   本地适配器只负责「调这里 → 直接返回结果」。
 *
 * 服务实例（store / workflow / …）由外部注入，方便测试时替换。
 */
// 并发互斥的判据只有一份（server/run-status.js）—— 重建大纲也要用它，别在路由层另写一份
import { findBlockingRun } from './run-status.js'

/* --------------------------------- 工具 --------------------------------- */

const qp = (query, key) => {
  if (!query) return null
  if (typeof query.get === 'function') return query.get(key) // URLSearchParams
  return query[key] ?? null
}

/**
 * @param {object} deps 依赖注入
 * @returns {(req: {path:string, method:string, query?:any, body?:any}) => Promise<{status:number, data?:any, file?:{mime:string,filename:string,body:string}}>}
 */
export function createApiRouter({
  store,
  pipeline,
  workflow,
  replanner,
  assistant,
  changes,
  testConnection,
  validateChapterCount,
  normalizeGenreTags,
}) {
  return async function handle({ path: p, method, query, body }) {
    const ok = (data) => ({ status: 200, data })
    const err = (status, message) => ({ status, data: { error: String(message) } })

    /* ------------------------------ 健康与配置 ------------------------------ */

    if (p === '/api/health' && method === 'GET') {
      const cfg = store.publicConfig()
      return ok({ ok: true, hasKey: cfg.hasKey, model: cfg.model, baseURL: cfg.baseURL })
    }

    if (p === '/api/config') {
      if (method === 'GET') return ok(store.publicConfig())
      if (method === 'POST') {
        const patch = {}
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim()
        if (typeof body.baseURL === 'string' && body.baseURL.trim()) patch.baseURL = body.baseURL.trim()
        if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim()
        if (typeof body.temperature === 'number') patch.temperature = body.temperature
        // 用户提供单价时才计算真实费用；不能猜测供应商实时价格。
        if (body.pricing && typeof body.pricing === 'object') patch.pricing = body.pricing
        if (body.chapterBudget !== undefined) patch.chapterBudget = body.chapterBudget
        if (body.maxChapterTokens !== undefined) patch.maxChapterTokens = body.maxChapterTokens
        if (body.inputBudget !== undefined) patch.inputBudget = body.inputBudget
        if (body.replanBudget !== undefined) patch.replanBudget = body.replanBudget
        store.saveConfig(patch)
        return ok(store.publicConfig())
      }
    }

    if (p === '/api/config/test' && method === 'POST') {
      try {
        const r = await testConnection(store.getConfig())
        // testConnection 已返回完整结构（mode / models / modelFound），原样透传
        return ok(r)
      } catch (e) {
        return ok({ ok: false, error: String(e?.message || e) })
      }
    }

    /* -------------------------------- 作品 -------------------------------- */

    if (p === '/api/projects' && method === 'GET') {
      return ok({ projects: store.listProjects() })
    }

    if (p === '/api/projects' && method === 'POST') {
      const idea = String(body.idea || '').trim()
      if (!idea) return err(400, '请先写下你的灵感。')
      let targetChapters
      try {
        targetChapters = validateChapterCount(body.targetChapters ?? 30)
      } catch (e) {
        return err(400, e.message)
      }
      const project = store.createProjectBase({
        idea,
        genre: body.genre,
        genreTags: normalizeGenreTags(body.genreTags, body.genre),
        targetChapters,
        preferences: body.preferences,
      })
      try {
        await pipeline.generateOutline(project)
        // 设定兜底补全：大纲模型漏填世界观/文风/作者偏好时，再单独补一次。
        // 只补空缺，不覆盖用户手填；失败绝不阻断创书（作品此时已可用）。
        let fillWarning = null
        try {
          const r = await pipeline.fillMissingSettings(project)
          if (!r.skipped && !r.filled.length && pipeline.missingSettingFields(project).length) {
            fillWarning = '部分设定未能自动补齐，可在「创作资料与编辑」中手动填写。'
          }
        } catch (e) { fillWarning = `设定自动补全未完成（${e?.message || e}），可手动补充。` }
        /**
         * 新大纲落地 ⇒ 清掉 `pendingReplan`（若还在的话）。
         *
         * `pendingReplan` 的语义是「**现有的**未来章节计划与作者设定冲突，需要重排」。
         * 既然大纲是**刚重新生成的**，它就是照着当前设定写的，不存在冲突。
         *
         * 真实踩坑：开书失败的空作品上改过设定 ⇒ 被置了 pendingReplan；
         * 之后重新生成大纲**成功**，但这条路由**不清标志** ⇒
         *   ① 想写第 1 章被拦「请先完成未写章节重排」；
         *   ② 去点「重排」⇒ 重排一个从没细化过的大纲，失败；
         *   ⇒ 彻底卡死，界面上没有任何出路。
         * （源头已在 change-request.applyChange 修掉：无未来章节受影响时不置位。
         *   这里是对**历史遗留脏标志**的兜底。新建作品那条分支天然没有该标志，写了也无害。）
         *
         * ⚠️ 只在**真的产出大纲**时才清：`generateOutline` 不 throw 不代表有卷
         *    （见「开书 API 大纲为空也返回 201」那个坑）。
         */
        if (project.outline?.volumes?.length && project.pendingReplan) {
          project.pendingReplan = false
          project.replanClearedAt = new Date().toISOString()
          project.replanClearedReason = 'outline-regenerated'
        }
        project.editRevision = Number(project.editRevision || 0) + 1
        store.saveProject(project)
        return ok(fillWarning ? { project, warning: fillWarning } : { project })
      } catch (e) {
        // 创建失败不伪装成已生成：保存可重试的失败项目，不写空大纲/空角色到正式成功态。
        project.status = 'outline_failed'
        project.outlineError = String(e?.message || e)
        project.outlineAttemptedAt = new Date().toISOString()
        store.saveProject(project)
        return ok({ project, warning: project.outlineError })
      }
    }

    const mProject = p.match(/^\/api\/projects\/([\w-]+)$/)
    if (mProject) {
      const id = mProject[1]
      if (method === 'GET') {
        const project = store.getProject(id)
        if (!project) return err(404, '作品不存在')
        return ok({ project })
      }
      if (method === 'DELETE') {
        // ⛔ 删除**先备份再删**（store.deleteProject），失败一律 409 + 明确原因，绝不静默返回 ok
        const r = store.deleteProject(id)
        return r.ok ? ok(r) : err(409, r.reason || '删除失败')
      }
    }

    /* ------------------------------ 作者修改请求 ------------------------------ */

    // 创建持久化预览，不得绕过确认、项目 CAS 和版本审计。
    const mChange = p.match(/^\/api\/projects\/([\w-]+)\/changes$/)
    if (mChange) {
      if (method === 'GET') return ok({ requests: changes.list(mChange[1]) })
      if (method === 'POST') {
        try {
          return { status: 201, data: { request: changes.create(mChange[1], body) } }
        } catch (e) {
          return err(409, e.message || e)
        }
      }
    }
    const mChangeRecord = p.match(/^\/api\/changes\/(cr_[0-9a-f]{24})(?:\/(approve|reject))?$/)
    if (mChangeRecord) {
      try {
        if (method === 'GET' && !mChangeRecord[2]) {
          const request = changes.get(mChangeRecord[1])
          return request ? ok({ request }) : err(404, '修改请求不存在')
        }
        if (method === 'POST' && mChangeRecord[2] === 'approve') return ok(changes.approve(mChangeRecord[1]))
        if (method === 'POST' && mChangeRecord[2] === 'reject') return ok({ request: changes.reject(mChangeRecord[1]) })
      } catch (e) {
        return err(409, e.message || e)
      }
    }

    // 废弃直接写入接口，所有 UI 修改必须经过 change-request 预览与确认。
    const mAuthor = p.match(/^\/api\/projects\/([\w-]+)\/author-settings$/)
    if (mAuthor && method === 'POST') {
      return err(410, '请通过修改请求预览并确认，不允许直接修改正式状态')
    }

    /* -------------------------------- 大纲 -------------------------------- */

    const mOutline = p.match(/^\/api\/projects\/([\w-]+)\/outline$/)
    if (mOutline && method === 'POST') {
      const project = store.getProject(mOutline[1])
      if (!project) return err(404, '作品不存在')
      /**
       * CAS：调用方可以带上它读到的 `editRevision`。不一致 ⇒ 期间有人改过设定，
       * 这次重建会**基于旧数据**覆盖掉那些改动 ⇒ 直接拒绝（与 `/changes` 同一套语义）。
       * ⛔ 这条原先缺：重建大纲走的是通用写 `saveProject`（**非 CAS**），
       *    于是「另一个标签页刚改完设定 → 旧标签页重建大纲」会安静地把改动冲掉。
       */
      if (body.expectedEditRevision != null
        && Number(body.expectedEditRevision) !== Number(project.editRevision || 0)) {
        return err(409, '设定已被修改，请刷新后再重建大纲')
      }
      // 重建大纲会整体替换规划 ⇒ 绝不能与正在跑的生成/重排任务并行（两边都在写同一份项目）
      if (findBlockingRun(store.listRuns(mOutline[1]))) {
        return err(409, '有任务正在执行，请等它结束或先停止后再重建大纲')
      }
      if ((project.chapters || []).some((ch) => ch.status === 'committed')) {
        return err(409, '已有正式章节，不能整体重建大纲；请先修改偏好并重排未写章节。')
      }
      if (typeof body.idea === 'string' && body.idea.trim()) project.idea = body.idea.trim()
      if (typeof body.genre === 'string' && body.genre.trim()) project.genre = body.genre.trim()
      if (Array.isArray(body.genreTags)) project.genreTags = normalizeGenreTags(body.genreTags, project.genre)
      try {
        await pipeline.generateOutline(project)
        // 设定兜底补全：大纲模型漏填世界观/文风/作者偏好时，再单独补一次。
        // 只补空缺，不覆盖用户手填；失败绝不阻断创书（作品此时已可用）。
        let fillWarning = null
        try {
          const r = await pipeline.fillMissingSettings(project)
          if (!r.skipped && !r.filled.length && pipeline.missingSettingFields(project).length) {
            fillWarning = '部分设定未能自动补齐，可在「创作资料与编辑」中手动填写。'
          }
        } catch (e) { fillWarning = `设定自动补全未完成（${e?.message || e}），可手动补充。` }
        /**
         * 新大纲落地 ⇒ 清掉 `pendingReplan`（若还在的话）。
         *
         * `pendingReplan` 的语义是「**现有的**未来章节计划与作者设定冲突，需要重排」。
         * 既然大纲是**刚重新生成的**，它就是照着当前设定写的，不存在冲突。
         *
         * 真实踩坑：开书失败的空作品上改过设定 ⇒ 被置了 pendingReplan；
         * 之后重新生成大纲**成功**，但这条路由**不清标志** ⇒
         *   ① 想写第 1 章被拦「请先完成未写章节重排」；
         *   ② 去点「重排」⇒ 重排一个从没细化过的大纲，失败；
         *   ⇒ 彻底卡死，界面上没有任何出路。
         * （源头已在 change-request.applyChange 修掉：无未来章节受影响时不置位。
         *   这里是对**历史遗留脏标志**的兜底。新建作品那条分支天然没有该标志，写了也无害。）
         *
         * ⚠️ 只在**真的产出大纲**时才清：`generateOutline` 不 throw 不代表有卷
         *    （见「开书 API 大纲为空也返回 201」那个坑）。
         */
        if (project.outline?.volumes?.length && project.pendingReplan) {
          project.pendingReplan = false
          project.replanClearedAt = new Date().toISOString()
          project.replanClearedReason = 'outline-regenerated'
        }
        project.editRevision = Number(project.editRevision || 0) + 1
        store.saveProject(project)
        return ok(fillWarning ? { project, warning: fillWarning } : { project })
      } catch (e) {
        // 若之前有成功的大纲，保留旧成果；不要因为一次失败毁掉正式内容。
        project.status = project.outline?.volumes?.length ? 'ready' : 'outline_failed'
        project.outlineError = String(e?.message || e)
        project.outlineAttemptedAt = new Date().toISOString()
        store.saveProject(project)
        return { status: 500, data: { error: project.outlineError, project } }
      }
    }

    /* ------------------------------ 重排 / 生成任务 ------------------------------ */

    const mReplan = p.match(/^\/api\/projects\/([\w-]+)\/replan$/)
    if (mReplan && method === 'POST') {
      try {
        const run = replanner.create(mReplan[1], { mode: body.mode === 'window' ? 'window' : 'full' })
        if (run.status === 'queued') void replanner.process(run.id).catch((e) => console.error('[replan]', e))
        return { status: 202, data: { run } }
      } catch (e) {
        return err(409, e.message || e)
      }
    }

    // R4：一切正文生成都必须先创建持久化任务，不允许旧同步接口绕开提交门禁。
    const mRuns = p.match(/^\/api\/projects\/([\w-]+)\/runs$/)
    const mChapters = p.match(/^\/api\/projects\/([\w-]+)\/chapters$/)
    if ((mRuns || mChapters) && method === 'POST') {
      const projectId = (mRuns || mChapters)[1]
      const project = store.getProject(projectId)
      if (!project) return err(404, '作品不存在')
      try {
        const no = Number(body.no) || project.chapters.length + 1
        const run = workflow.createRun(projectId, no, {
          requestKey: body.requestKey || null,
          expectedHeadVersion: body.expectedHeadVersion ?? null,
          autoCommit: body.autoCommit !== false,
        })
        // 不等待模型：即使客户端关闭网页，仍继续执行并将进度保存在 data/runs。
        if (run.status === 'queued') void workflow.process(run.id).catch((e) => console.error('[run]', e))
        return { status: 202, data: { run } }
      } catch (e) {
        return err(409, e.message || e)
      }
    }
    if (mRuns && method === 'GET') return ok({ runs: workflow.listRuns(mRuns[1]) })

    const mRun = p.match(/^\/api\/runs\/(run_[a-f0-9]{24})(?:\/(context|resume|cancel|accept))?$/)
    if (mRun) {
      const [, runId, action] = mRun
      const run = workflow.getRun(runId)
      if (!run) return err(404, '生成任务不存在')
      const actor = run?.type === 'replan' ? replanner : workflow
      if (!action && method === 'GET') return ok({ run })
      if (action === 'context' && method === 'GET') {
        return ok({ manifest: run.manifest, prompt: run.context, plan: run.plan })
      }
      if (method === 'POST') {
        try {
          if (action === 'cancel') return ok({ run: actor.cancel(runId) })
          if (action === 'resume') {
            void actor.resume(runId).catch((e) => console.error('[resume]', e))
            return { status: 202, data: { run: workflow.getRun(runId) } }
          }
          if (action === 'accept' && run.type !== 'replan') return ok({ run: await workflow.accept(runId) })
        } catch (e) {
          return err(409, e.message || e)
        }
      }
    }

    /* ------------------------------- AI 助手 ------------------------------- */

    // A3：统一的 AI 助手提议/确认通道。正文与安全规则不开放写入。
    const assistantCreate = p === '/api/assistant/create' && method === 'POST'
    const assistantProject = p.match(/^\/api\/projects\/([\w-]+)\/assistant$/)
    if (assistantCreate || (assistantProject && method === 'POST')) {
      try {
        const run = await assistant.propose({
          projectId: assistantCreate ? null : assistantProject[1],
          input: body,
        })
        return ok({ run })
      } catch (e) {
        return err(400, e.message || e)
      }
    }
    const assistantReply = p.match(/^\/api\/assistant\/(run_[0-9a-f]{24})\/reply$/)
    if (assistantReply && method === 'POST') {
      try {
        return ok(assistant.reply(assistantReply[1], body.message))
      } catch (e) {
        return err(409, e.message || e)
      }
    }

    /* -------------------------------- 导出 -------------------------------- */

    const mExport = p.match(/^\/api\/projects\/([\w-]+)\/export$/)
    if (mExport && method === 'GET') {
      const project = store.getProject(mExport[1])
      if (!project) return err(404, '作品不存在')
      // 导出格式（md / txt）与内容分区（parts）都由用户在前端勾选，这里只做归一化与校验
      const doc = pipeline.exportDocument(project, {
        format: qp(query, 'format') || undefined,
        parts: qp(query, 'parts') || undefined,
      })
      // 导出不走 JSON：交给调用方决定如何交付（HTTP 下载 / App 内写文件分享）
      return { status: 200, file: { mime: doc.mime, filename: doc.filename, body: doc.body } }
    }

    // 导出可选项：格式与内容分区，供前端渲染导出面板。
    // ⚠️ 与 `sections` 同形状（带 label/hint）—— 否则前端只能自己再抄一份带文案的清单，
    //    而那份抄件正是「服务端下发了 formats 却没人读」的原因。
    if (p === '/api/export-options' && method === 'GET') {
      return ok({
        formats: Object.entries(pipeline.EXPORT_FORMATS).map(([key, v]) => ({ key, label: v.label, note: v.note, ext: v.ext })),
        sections: pipeline.EXPORT_SECTIONS,
      })
    }

    return err(404, '接口不存在')
  }
}
