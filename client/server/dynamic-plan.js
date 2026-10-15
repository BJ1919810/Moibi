/**
 * L2 可选细化：当作者侧章节任务未被授权直送正文时，
 * 使用已过滤的 WriterPacket 请求一个“只能写表层动作”的小规划。
 * 规划模型没有作者秘密，因此不会因看到秘密而提前安排相关剧情。
 */
import { renderWriterPacket, findLeaks } from './projection.js'

export function safePlanMessages(packet) {
  return [
    { role: 'system', content: '你是章节场景任务编辑。只能使用用户给出的公开资料，不得引入新人物、未来真相、隐藏身份或新能力。只输出 JSON。' },
    { role: 'user', content: `${renderWriterPacket(packet)}\n\n请把本章任务细化成当前人物能完成的可观察变化；不要引用任何未提供的后续章节内容。只输出 {"summary":"100字以内的表层行动方案","goal":"60字以内的可验收变化"}。` },
  ]
}

export function applySafePlan(packet, project, proposed) {
  const summary = String(proposed?.summary || '').trim()
  const goal = String(proposed?.goal || '').trim()
  if (!summary || !goal || summary.length > 180 || goal.length > 100) throw new Error('L2 场景任务结构或长度无效')
  const next = structuredClone(packet)
  next.task.summary = summary
  next.task.goal = goal
  const leaks = findLeaks(next, project)
  if (leaks.length) throw new Error('L2 场景任务触发信息泄漏检查')
  return next
}
