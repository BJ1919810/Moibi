/** 费用计量。单价均由用户配置，单位：货币/百万 tokens；未知单价返回 null。 */
export function calculateCost(usages = [], rates = null) {
  if (!rates || ![rates.inputPerMillion, rates.outputPerMillion].every((v) => Number.isFinite(Number(v)) && Number(v) >= 0)) return null
  let sum = 0
  for (const u of usages) {
    const input = Math.max(0, Number(u.inputTokens) || 0)
    const output = Math.max(0, Number(u.outputTokens) || 0)
    const cached = Math.min(input, Math.max(0, Number(u.cachedInputTokens) || 0))
    const cacheRate = Number.isFinite(Number(rates.cachedInputPerMillion)) ? Number(rates.cachedInputPerMillion) : Number(rates.inputPerMillion)
    sum += ((input - cached) * Number(rates.inputPerMillion) + cached * cacheRate + output * Number(rates.outputPerMillion)) / 1e6
  }
  return sum
}

/** 在每一次可能付费的外部请求前检查，不在超额度后才发警报。 */
export function assertCostBudget(current, estimatedNext, limit) {
  if (limit == null || limit === '') return
  const n = Number(limit)
  if (!Number.isFinite(n) || n < 0) throw new Error('费用预算配置无效')
  if (Number(current || 0) + Number(estimatedNext || 0) > n) throw new Error('费用预算不足：已停止新的模型调用')
}

export function usageSummary(usages = [], rates = null) {
  const totals = { calls: usages.length, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }
  for (const u of usages) for (const key of Object.keys(totals).slice(1)) totals[key] += Math.max(0, Number(u[key]) || 0)
  return { ...totals, estimatedCost: calculateCost(usages, rates) }
}
