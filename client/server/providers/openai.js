/**
 * ProviderAdapter：模型调用适配层。
 *
 * 统一走 OpenAI 兼容的 /chat/completions 协议 —— DeepSeek、通义、Kimi、
 * 智谱、OpenAI、以及各类中转站都兼容，换供应商只改配置不改代码。
 *
 * 职责边界（对应工程规划文档 §12）：只负责调用、超时、重试、usage 归一化；
 * 不做业务校验，业务校验在 pipeline 层。
 *
 * 关于「深度思考」（thinking）：
 *   DeepSeek V4.1-Flash 等新模型默认开启思考模式，思考内容走 reasoning_content，
 *   同样按输出计费。长篇小说逐章生成会把成本显著推高，因此默认关闭；
 *   设置页可手动打开。不支持的供应商会自动降级忽略该参数。
 */

export class ProviderError extends Error {
  constructor(message, { status, retryable = false, usage = null } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.retryable = retryable
    // 已得到 HTTP 200 的空内容也可能计费：不可因为抛错丢失 usage。
    this.usage = usage
  }
}

function joinURL(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 单次对话调用。
 * @returns {Promise<{text: string, usage: {inputTokens:number, outputTokens:number, reasoningTokens:number}}>}
 */
export async function chat({
  baseURL,
  apiKey,
  model,
  messages,
  temperature = 0.9,
  maxTokens = 4096,
  jsonMode = false,
  thinking = false,
  timeoutMs = 180000,
  retries = 2,
}) {
  if (!apiKey) {
    throw new ProviderError('未配置 API Key，请先在「设置」里填写。', { status: 401 })
  }

  // 思考过程同样消耗输出 token，开启时自动为正文额外预留空间
  const effectiveMaxTokens = thinking ? maxTokens + 4096 : maxTokens

  const body = {
    model,
    messages,
    temperature,
    max_tokens: effectiveMaxTokens,
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  if (typeof thinking === 'boolean') {
    body.thinking = { type: thinking ? 'enabled' : 'disabled' }
  }

  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(joinURL(baseURL, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const retryable = res.status === 429 || res.status >= 500

        // 供应商不认 thinking 参数时自动去掉重试，保证换供应商不受影响
        if (
          body.thinking &&
          res.status >= 400 &&
          /thinking|reasoning|unknown|unsupported|invalid/i.test(detail)
        ) {
          delete body.thinking
          lastErr = new ProviderError(
            `该供应商不支持 thinking 参数，已自动忽略：${detail.slice(0, 160)}`,
            { status: res.status, retryable: true }
          )
          continue
        }

        // 部分供应商不支持 response_format，降级去掉后重试一次
        if (jsonMode && res.status >= 400 && /response_format|json/i.test(detail)) {
          delete body.response_format
          lastErr = new ProviderError(`供应商不支持 JSON 模式：${detail.slice(0, 200)}`, {
            status: res.status,
            retryable: true,
          })
          continue
        }

        throw new ProviderError(
          `模型接口返回 ${res.status}：${detail.slice(0, 300) || res.statusText}`,
          { status: res.status, retryable }
        )
      }

      const data = await res.json()
      const choice = data?.choices?.[0] || {}
      const msg = choice.message || {}
      const text = String(msg.content ?? '').trim()
      const reasoning = String(msg.reasoning_content ?? '').trim()
      const usage = {
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
        reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        cachedInputTokens: data?.usage?.prompt_cache_hit_tokens ?? data?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      }

      if (!text) {
        // 最常见的情形：思考模式把 max_tokens 耗尽了，正文一个字都没剩
        if (reasoning) {
          throw new ProviderError(
            `模型只产出了思考内容、没有正文。通常是输出上限（${effectiveMaxTokens} tokens）被思考过程耗尽——请调大上限或关闭「深度思考」。`,
            { status: 502, retryable: false, usage }
          )
        }
        const finish = choice.finish_reason ? `（finish_reason: ${choice.finish_reason}）` : ''
        throw new ProviderError(
          `模型返回内容为空${finish}。请确认模型名拼写与账号额度是否正常。`,
          { status: 502, retryable: false, usage }
        )
      }

      return { text, usage, finishReason: choice.finish_reason || null }
    } catch (err) {
      lastErr =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              err?.name === 'AbortError'
                ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
                : String(err?.message || err),
              { retryable: true }
            )
    } finally {
      clearTimeout(timer)
    }

    if (!lastErr.retryable || attempt === retries) break
    await sleep(800 * 2 ** attempt + Math.random() * 400) // 有界指数退避 + 抖动
  }

  throw lastErr || new ProviderError('模型调用失败')
}

/**
 * 连通性自检。
 *
 * 优先走 GET /models：只验证密钥与接口地址，**不消耗任何 token**，
 * 也不掺入 thinking、response_format 这类业务参数——测的就是「API 通不通」本身。
 * 顺带把账号可用模型列出来，方便核对模型名有没有写错。
 *
 * 少数中转站没实现 /models，这时才回退到一次极短的对话探测。
 */
export async function testConnection(cfg) {
  const base = String(cfg.baseURL || '').replace(/\/+$/, '')
  if (!base) throw new ProviderError('请先填写接口地址。', { status: 400 })
  if (!cfg.apiKey) throw new ProviderError('请先填写 API Key。', { status: 400 })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  let res
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctrl.signal,
    })
  } catch (err) {
    throw new ProviderError(
      err?.name === 'AbortError'
        ? '连接超时，请检查接口地址与网络。'
        : `无法连接：${err?.message || err}`
    )
  } finally {
    clearTimeout(timer)
  }

  // 未实现 /models 的供应商，退回对话探测
  if ([404, 405, 501].includes(res.status)) {
    return probeByChat(cfg)
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('密钥无效或没有权限，请检查 API Key。', { status: res.status })
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ProviderError(
      `接口返回 ${res.status}：${detail.slice(0, 200) || res.statusText}`,
      { status: res.status }
    )
  }

  const data = await res.json().catch(() => ({}))
  const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
  return {
    ok: true,
    mode: 'models',
    models,
    // 列表为空时无法判断，返回 null 让前端跳过这项提示
    modelFound: models.length ? models.includes(cfg.model) : null,
  }
}

/** 回退路径：一次极短对话。不传任何业务参数，只探活 */
async function probeByChat(cfg) {
  const { text, usage } = await chat({
    ...cfg,
    messages: [
      { role: 'system', content: '你是连通性探针。' },
      { role: 'user', content: '只回复两个字：可以。' },
    ],
    maxTokens: 2048,
    temperature: 0,
    thinking: undefined, // 显式清掉，避免把业务参数带进纯连通性检测
    timeoutMs: 60000,
    retries: 0,
  })
  return { ok: true, mode: 'chat', reply: text.trim().slice(0, 20), usage }
}
