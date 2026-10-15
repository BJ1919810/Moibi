/**
 * App 内后端：把 server/ 的全部逻辑装配成可在浏览器/WebView 里直接调用的对象。
 *
 * 与 server/index.js 的唯一区别是**没有 HTTP 层**：
 *   index.js        ：HTTP 请求 → api-router → HTTP 响应
 *   backend/app.js  ：函数调用 → api-router → 返回值
 * 两者共用同一个 `createApiRouter`，业务逻辑只有一份。
 *
 * ⚠️ 本模块会 import 五个 `node:*` shim 与被垫片补齐的全局对象，
 * 因此 **必须在 Vite 里通过 alias 把 node:* 指向 shims/**，且第一行先装上
 * 运行时垫片（否则 store.js 求值时就 ReferenceError）。
 */
import './runtime.js'

import * as store from '../../server/store.js'
import * as pipeline from '../../server/pipeline.js'
import { testConnection } from '../../server/providers/openai.js'
import { createWorkflow } from '../../server/workflow.js'
import { createReplanService } from '../../server/replan.js'
import { createAssistantService } from '../../server/assistant.js'
import { createChangeService } from '../../server/change-request.js'
import { createApiRouter } from '../../server/api-router.js'
import { validateChapterCount, normalizeGenreTags } from '../../server/creative-options.js'

const workflow = createWorkflow()
const replanner = createReplanService()
const assistant = createAssistantService()
const changes = createChangeService()

const router = createApiRouter({
  store,
  pipeline,
  workflow,
  replanner,
  assistant,
  changes,
  testConnection,
  validateChapterCount,
  normalizeGenreTags,
})

/**
 * 统一的本地调用入口（与 HTTP 返回体结构保持一致）。
 * @param {string} path  形如 '/api/projects'
 * @param {object} [options] { method='GET', body, query }
 * @returns {Promise<any>} 成功返回业务数据；失败抛 Error（错误文案与 HTTP 版一致）
 */
export async function call(path, { method = 'GET', body = {}, query = null } = {}) {
  const result = await router({ path, method, body, query })

  if (result.file) {
    // 导出：本地形态直接返回文本内容，由调用方决定写文件或分享
    return { __file: true, ...result.file }
  }

  if (result.status >= 400) {
    throw new Error(result.data?.error || `请求失败（${result.status}）`)
  }
  return result.data
}

/** App 启动时恢复排队中/中断的任务（对应 index.js 启动时的 resume 逻辑） */
export function resumePendingRuns() {
  let restored = 0
  try {
    for (const run of store.listRuns()) {
      if (run.status === 'queued' || (run.status === 'planning' && run.step !== 'l2-call')) {
        const actor = run.type === 'replan' ? replanner : workflow
        void actor.process(run.id).catch((e) => console.error('[startup-resume]', e))
        restored++
      } else if (run.status === 'writing' || run.status === 'extracting' || run.step === 'l2-call') {
        // 不确定是否已发出模型请求：不自动重发，留给用户手动「恢复任务」决定
        const actor = run.type === 'replan' ? replanner : workflow
        void actor.process(run.id).catch((e) => console.error('[startup-uncertain]', e))
        restored++
      }
    }
  } catch (e) {
    console.error('[backend] 恢复任务失败：', e)
  }
  return restored
}

export { store, pipeline }
