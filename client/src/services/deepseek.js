const API_URL = 'https://api.deepseek.com/chat/completions';
const MODELS_URL = 'https://api.deepseek.com/models';
const KEY_SLOT = 'mobin.deepseek.key';
const THINKING_SLOT = 'mobin.deepseek.thinking';

// ---------- API Key 安全存储 ----------
// Android：写入 Keystore 加密存储（@aparajita/capacitor-secure-storage）；
// 网页端：localStorage（开发调试）。启动时自动把旧明文迁移到安全存储后清除。
let keyCache = null;
let secureStorePromise = null;

function getSecureStore() {
  if (!secureStorePromise) {
    secureStorePromise = (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return null;
        const mod = await import('@aparajita/capacitor-secure-storage');
        return mod.SecureStorage;
      } catch {
        return null;
      }
    })();
  }
  return secureStorePromise;
}

/** 应用启动时读取 Key：原生优先安全存储，并把旧的 localStorage 明文迁移过去后清除 */
export async function loadKey() {
  const store = await getSecureStore();
  if (store) {
    try {
      const secured = await withTimeout(store.getItem(KEY_SLOT), 3000, null);
      if (secured) {
        keyCache = secured;
        try { localStorage.removeItem(KEY_SLOT); } catch { /* ignore */ }
        return secured;
      }
      const legacy = localStorage.getItem(KEY_SLOT) || '';
      if (legacy) {
        keyCache = legacy;
        await withTimeout(store.set(KEY_SLOT, legacy), 3000);
        try { localStorage.removeItem(KEY_SLOT); } catch { /* ignore */ }
        return legacy;
      }
      keyCache = '';
      return '';
    } catch { /* 安全存储异常时回退 localStorage */ }
  }
  keyCache = localStorage.getItem(KEY_SLOT) || '';
  return keyCache;
}

export const getKey = () => (keyCache !== null ? keyCache : (localStorage.getItem(KEY_SLOT) || ''));

export async function saveKey(k) {
  const value = k.trim();
  keyCache = value;
  const store = await getSecureStore();
  if (store) {
    try {
      if (value) await withTimeout(store.set(KEY_SLOT, value), 3000);
      else await withTimeout(store.remove(KEY_SLOT), 3000);
      try { localStorage.removeItem(KEY_SLOT); } catch { /* ignore */ }
    } catch { /* 安全存储失败不阻断 */ }
    return;
  }
  try {
    if (value) localStorage.setItem(KEY_SLOT, value);
    else localStorage.removeItem(KEY_SLOT);
  } catch { /* ignore */ }
}

export const getThinking = () => localStorage.getItem(THINKING_SLOT) === '1';
export const saveThinking = (v) => localStorage.setItem(THINKING_SLOT, v ? '1' : '0');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 给 Promise 加超时兜底：超时返回 fallback，避免安全存储等调用卡死整个流程 */
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

/** 从 DeepSeek 错误响应中提取可读信息 */
function extractError(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) return String(parsed.error.message);
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch { /* 非 JSON 响应 */ }
  return fallback;
}

// ---------- 全局取消：同一时刻只有一个 AI 请求，注册当前控制器供“停止”按钮调用 ----------
let activeCtrl = null;
let cancelRequested = false;

export const abortActiveRequest = () => {
  cancelRequested = true;
  activeCtrl?.abort();
};

function registerCtrl(ctrl) {
  cancelRequested = false;
  activeCtrl = ctrl;
  return () => { if (activeCtrl === ctrl) activeCtrl = null; };
}

// -------------------- 流式请求核心 --------------------
/**
 * 以 SSE 流式方式调用 DeepSeek API，返回拼接后的完整内容。
 * 对 429 / 5xx 自动做最多 2 次退避重试；其余错误直接抛出。
 *
 * @param {Array}    messages
 * @param {Object}   opts
 * @param {number}   opts.temperature
 * @param {number}   opts.maxTokens
 * @param {number}   opts.timeout       - 总超时（ms），默认 300s
 * @param {Function} opts.onChunk       - 可选，每收到一个 chunk 回调 (deltaText) => void
 */
async function chatStream(messages, {
  temperature = 0.8,
  maxTokens = 4096,
  timeout: customTimeout,
  onChunk,
  onFinish,
  thinking = false,
  useReasoningFallback = true,
  prefill,
} = {}) {
  // 先注册取消/超时：保证任何环节（含 Key 读取）都能被“停止”打断
  const timeout = customTimeout ?? 300_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const unregister = registerCtrl(ctrl);

  // Key 读取不阻塞请求流程：最多等 4 秒，超时直接回退（安全存储异常时用 localStorage）
  if (keyCache === null) {
    await Promise.race([loadKey(), sleep(4000)]);
  }
  const apiKey = getKey();
  if (!apiKey) {
    throw new Error('还没研墨呢——请先点右下角 🖌 填入 DeepSeek API Key');
  }

  const body = {
    model: 'deepseek-v4-flash',
    // 预填充（prefill）：在消息末尾放一条 assistant 消息，强制模型从该前缀开始“接龙”，
    // 从机制上跳过“好的，让我先看看需求”这类元话术
    messages: prefill ? [...messages, { role: 'assistant', content: prefill }] : messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };

  // 思考模式：开启时添加 thinking 和 reasoning_effort 参数；
  // 未开启时显式发送 disabled，防止模型默认输出推理流（浪费 token 并混入英文思考）
  // 注：思考模式下 temperature 不生效（官方文档），且 reasoning 会占用 token 预算，
  // 故 max_tokens 提升至 8192，并移除 temperature 避免误解
  if (thinking) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = 'high';
    body.max_tokens = 8192;
    delete body.temperature;
  } else {
    body.thinking = { type: 'disabled' };
  }

  const attemptFetch = async (attempt) => {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (resp.ok) return resp;

    const text = await resp.text().catch(() => '');
    const retryable = resp.status === 429 || [500, 502, 503, 504].includes(resp.status);
    if (retryable && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return attemptFetch(attempt + 1);
    }
    const detail = extractError(text, text.slice(0, 160));
    throw new Error(`DeepSeek 请求失败（${resp.status}）${detail ? `：${detail}` : ''}`);
  };

  try {
    const resp = await attemptFetch(0);

    // ---- 逐行解析 SSE ----
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let content = '';
    let reasoningContent = '';
    let buffer = '';
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以 \n 分隔，每条消息以 "data: " 开头
      const lines = buffer.split('\n');
      // 最后一行可能不完整，留到下次
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;

        // 思考模式：reasoning_content 是思考过程
        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
        }
        // content 是正式回复
        if (delta.content) {
          content += delta.content;
          onChunk?.(delta.content);
        }
      }
    }

    // 通知调用方流式结束原因（如 length 表示被截断），用于失败重试
    onFinish?.(finishReason);

    // 达到 max_tokens 上限：保留已生成内容（哪怕不完整），末尾标注截断提示
    if (finishReason === 'length') {
      const partial = content.trim() || (useReasoningFallback ? reasoningContent.trim() : '');
      if (partial) {
        return (prefill || '') + partial + `\n\n---\n⚠️ 达到 max_tokens 上限（${body.max_tokens}），内容被截断，可调大 maxTokens 后重试。`;
      }
    }

    // 兜底：content 为空时取 reasoning（discuss 等依赖 content 解析的场景可关 useReasoningFallback）
    const finalContent = content.trim() || (useReasoningFallback ? reasoningContent.trim() : '');

    if (!finalContent) {
      throw new Error('API 流式返回完毕但内容为空，请检查模型或参数');
    }

    return (prefill || '') + finalContent;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (cancelRequested) throw new Error('已取消');
      throw new Error(`请求超时（${timeout / 1000}s），请检查网络或稍后重试`);
    }
    throw e;
  } finally {
    unregister();
    clearTimeout(timer);
  }
}

/** 验证 API Key 是否有效（GET /models 最省 token） */
export async function testKey(key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const unregister = registerCtrl(ctrl);
  try {
    if (key === undefined || key === null) {
      if (keyCache === null) await Promise.race([loadKey(), sleep(4000)]);
      key = getKey();
    }
    if (!key) return { ok: false, message: '请先填写 API Key' };
    const resp = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: ctrl.signal,
    });
    const text = await resp.text().catch(() => '');
    if (resp.ok) return { ok: true, message: 'Key 有效，可以开始创作 ✍️' };
    const detail = extractError(text, text.slice(0, 120));
    return { ok: false, message: `Key 无效（${resp.status}）${detail ? `：${detail}` : ''}` };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, message: '检测超时或已取消' };
    return { ok: false, message: `无法连接 DeepSeek：${e.message}` };
  } finally {
    clearTimeout(timer);
    unregister();
  }
}

// -------------------- 思考模式提示词片段 --------------------
// 开启思考模式时，追加到 system prompt 末尾，防止模型把正式内容输出到 reasoning 里
const THINKING_HINT = `

## 思考模式注意
你正在使用思考模式。请注意：
- 思考过程（reasoning）只用于分析关键信息和规划结构
- 所有正式内容必须输出在 content 中，不要在 reasoning 里重复输出完整内容
- 避免在 reasoning 和 content 中输出重复内容，以节省 token`;

// -------------------- 一致性铁律 --------------------
// 供章节续写使用，防止 AI 遗忘或推翻已确认设定
const CONSISTENCY_RULE = `## 一致性铁律（最高优先）
1. 正文、【随笔】、【设定更新】必须与【剧情大纲】【角色设定】【伏笔设计】【设定簿】完全一致，不得遗忘、弱化或推翻其中任何已确认的事实。
2. 主角或任何角色已经获得的能力、物品、身份，后续必须自然沿用或明确交代变化，严禁“凭空消失”或毫无交代地失去。
3. 任何新的不可逆设定变化（新增能力、获得/失去物品、身份或关系变更等）必须在正文有依据，并逐条写入【设定更新】块。`;

// 通用“只输出成品”约束：防止模型把推理/过渡话术混入输出（各模块统一追加）
const NO_META = '你的回复必须通篇都是最终的成品内容本身：不要输出对任务的理解、推理过程、过渡语、客套话或元话术，也不要复述我提供的素材。一律使用简体中文输出。';

// -------------------- 上下文构建 --------------------
function buildContext({ name, category, coreIdea, outline, characters, foreshadowing, memory }) {
  const lines = [
    `书名：《${name}》`,
    `分类：${category || '未分类'}`,
    `核心想法：${coreIdea}`,
  ];
  if (outline) lines.push(`\n【剧情大纲】\n${outline}`);
  if (characters) lines.push(`\n【角色设定】\n${characters}`);
  if (foreshadowing) lines.push(`\n【伏笔设计】\n${foreshadowing}`);
  if (memory) lines.push(`\n【设定簿】（已确认的作品事实，禁止遗忘或矛盾；主角已获得的能力必须沿用）\n${memory}`);
  return lines.join('\n');
}

// -------------------- 业务接口 --------------------

export async function outline({ name, category, coreIdea, outline: prev, characters, foreshadowing, memory }) {
  const hasPrev = !!prev;
  const thinking = getThinking();
  const systemPrompt = `你是一位资深长篇网文策划编辑，擅长把一句话灵感深化成扎实、有层次的故事架构。
## 创作原则
- 忠于类型与主题：言情就写言情、校园就写校园。扩展要深化本类型，而不是混入或切换成其他题材。
- 把一句话灵感当成种子，在题材的土壤里长成大树：靠情感、人物关系、主题与冲突层次来扩展，而非堆砌异质元素。
- 构建多层冲突（内心 → 人际 → 观念 → 类型核心矛盾），层层递进，不要随意上升到"势力线/世界线"；设计主线 + 副线 + 暗线，每条线服务于核心主题。
- 如果已有角色设定或伏笔设计，必须严格沿用其中的人名、身份、称号与关系网，只做深化与扩展，不得擅自推翻。
- 在用户已有内容基础上合理扩展约 2-3 倍，避免逐字演绎。
## 输出格式
- 第一行必须是 "# 一句话梗概"
- 用二级标题分板块：一句话梗概、背景设定、主线、副线+暗线、三幕结构、走向、结局
- 三幕结构只写每幕的情节梗概与叙事功能，不要列举具体章节范围；结局只写人物归宿与情感走向，不展开场景、对话与细节
- 一次性给出最终版本：输出全程只有大纲本身，不包含任何修改、整理、归档、说明或过程性文字
${NO_META}${thinking ? THINKING_HINT : ''}`;

  const content = await chatStream([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: hasPrev ? `以下是我已有的作品信息和大纲，请在忠于类型与主题的前提下优化扩展：\n\n${buildContext({ name, category, coreIdea, characters, foreshadowing, memory })}\n\n已有大纲（请在保持题材基调的基础上深化，不要擅自切换类型）：\n${prev}` : `请基于以下信息，创作一部长篇小说的完整剧情架构。注意：必须忠于所选分类与主题，在既定类型内深化展开，不要跳到其他题材。\n\n${buildContext({ name, category, coreIdea, characters, foreshadowing, memory })}` },
  ], { temperature: 1.0, maxTokens: 8192, thinking, useReasoningFallback: false, prefill: '# 一句话梗概\n' });
  return { content };
}

export async function characters({ name, category, coreIdea, outline, memory }) {
  const thinking = getThinking();
  const content = await chatStream([
    {
      role: 'system',
      content: `你是一位角色设计大师，擅长为长篇小说创造有血有肉、动机清晰的群像阵容。
## 设计要求
- 设计 5-8 个角色，分三类：
  1. 主角团（2-3人）：性格互补、有清晰的成长轨迹
  2. 配角群（2-3人）：推动剧情的关键节点，有独立故事线
  3. 反派/对立面（2-3人）：动机必须合理，不作"纯恶"
- 每个角色包含：姓名、身份/称号、外貌特征、性格、核心动机、人物弧光、关系网
- 每个角色注明"高光时刻"的大致阶段（角色个人的爆发/转折点）；跨章节的全局伏笔交给伏笔模块
- 用 Markdown 列出，简洁精炼
- 设定必须忠于作品分类的题材基调，不引入与类型冲突的设定（如言情里塞入修仙力量体系、校园里塞入异能/末世元素）
- 一次性给出最终版本：输出全程只有角色设定本身，不包含任何修改、整理、归档、说明或过程性文字
${NO_META}${thinking ? THINKING_HINT : ''}`,
    },
    { role: 'user', content: `请为以下作品设计主要角色阵容：\n\n${buildContext({ name, category, coreIdea, outline, memory })}` },
  ], { temperature: 1.0, maxTokens: 8192, thinking, useReasoningFallback: false });
  return { content };
}

export async function foreshadowing({ name, category, coreIdea, outline, characters, memory }) {
  const thinking = getThinking();
  const content = await chatStream([
    {
      role: 'system',
      content: `你是叙事诡计与长篇伏笔设计大师。
## 输出格式（必须严格遵守）
- 直接以 "## 远端伏笔" 开头（该行已由系统写好，直接从条目开始输出，不要重复输出标题）
- 用二级标题按揭示时机分三组：远端伏笔、中端伏笔、近端伏笔，共 8-12 条
- 每条固定为一行：**伏笔名称** ～埋设：xx ～揭示：远端/中端/近端 ～呼应：xx ～作用：xx（各字段用简短短语）
- 埋设与呼应的时机用剧情阶段或事件描述（如"开局""中期""终局前""某事件期间"），不要写具体章节序号
## 结构示例
## 远端伏笔
- **旧怀表** ～埋设：开局祖父遗物 ～揭示：远端 ～呼应：终局揭穿真凶 ～作用：……
## 中端伏笔
- **XX** ～埋设：…… ～揭示：中端 ～呼应：…… ～作用：……
## 近端伏笔
- **XX** ～埋设：…… ～揭示：近端 ～呼应：…… ～作用：……
## 设计原则
- 伏笔互相勾连成网络，不孤立；远端伏笔至少 3 条；自然融入，部分可伪装成无关细节
- 只写跨章节、跨角色的全局线索；角色个人的高光/转折点交给角色模块
- 伏笔必须服务于既定类型与主题，不得用异质元素制造悬疑/玄幻感（除非分类本身就是悬疑/玄幻）
${NO_META}${thinking ? THINKING_HINT : ''}`,
    },
    { role: 'user', content: `请为以下作品设计伏笔网络：\n\n${buildContext({ name, category, coreIdea, outline, characters, memory })}` },
  ], { temperature: 1.0, maxTokens: 4096, thinking, useReasoningFallback: false, prefill: '## 远端伏笔\n' });
  return { content };
}

export async function chapter({ name, category, coreIdea, outline, characters, foreshadowing, memory, prevChapter, chapterIndex, notes, hint, correction, onChunk }) {
  const thinking = getThinking();
  const prevInfo = prevChapter ? `## 上一章信息
章节：第 ${chapterIndex - 1} 章《${prevChapter.title}》
开头 300 字：${prevChapter.content.slice(0, 300)}
结尾 300 字：${prevChapter.content.slice(-300)}` : '';

  const sysContent = '你是一位文笔细腻、画面感极强的小说家。严格遵循大纲与人设，保持文风连贯，注意伏笔的埋设。一律使用简体中文输出。第一行输出"第X章 标题"，随后立即进入正文。正文内容要充实丰满，每章正文不少于 2000 字，不要过于简略。' + (thinking ? THINKING_HINT : '');

  const content = await chatStream([
    { role: 'system', content: sysContent },
    { role: 'user', content:
`${buildContext({ name, category, coreIdea, outline, characters, foreshadowing, memory })}

${prevInfo}

${notes ? `## 上一章随笔（作者备查，供参考）\n${notes}` : ''}

${hint ? `## 本章用户提示
用户希望本章参考以下内容作为开头或动机：
${hint}` : ''}

现在续写第 ${chapterIndex} 章正文：
1. 第一行直接是"第X章 标题"，随后立即进入正文，正文从第一个字开始就是小说本身。
2. 正文不少于 2000 字（目标 2500-3000 字），结构饱满：至少 2-3 个场景转换、5 段以上对话，多用动作与对话刻画，少用说明性旁白；开头承接上一章结尾，章末留钩子。
3. 动笔前先定本章动机：延续上一章基调，或按大纲推进到新阶段；不要原地重复上一章的情节与情绪。
4. 正文写完后，在末尾输出【随笔】块（不超过 300 字）：逐条记录本章关键状态变化（新增能力/获得物品/关系变化等），以及埋下的铺垫、未完成的悬念、下一章计划。

${CONSISTENCY_RULE}${correction ? `\n\n${correction}` : ''}` },
  ], { temperature: 0.9, maxTokens: 6144, thinking, useReasoningFallback: false, prefill: `第${chapterIndex}章 `, onChunk });

  // 第二轮：把本章正文作为上下文，规范输出【设定更新】块，独立同步到设定簿
  const round2User = `根据你刚写的本章正文，规范简略地输出【设定更新】块：
- 逐条列出不可逆设定变化：新增/成长的能力、获得或失去的物品、身份/关系变更、重大地点迁移、新登场的重要角色
- 每行固定格式：- 能力：名称（来源/触发条件/当前限制）
- 若本章没有此类变化，输出：
【设定更新】
（无）
- 只输出【设定更新】块本身，不要正文或说明。`;

  const stateUpdate = await chatStream([
    { role: 'system', content: sysContent },
    { role: 'assistant', content },
    { role: 'user', content: round2User },
  ], { temperature: 0.3, maxTokens: 1024, thinking, useReasoningFallback: false, prefill: '【设定更新】\n' });

  return { content, stateUpdate };
}

/** 章节漏掉【设定更新】块时的补抽：只根据本章正文提取设定更新，不重写正文 */
export async function chapterUpdateOnly({ name, content, memory }) {
  const thinking = getThinking();
  const body = String(content || '').trim().slice(0, 6000);
  if (!body) throw new Error('没有可用的章节正文');
  const out = await chatStream([
    {
      role: 'system',
      content: `你是长篇小说的设定管理员，根据一章正文提取该章新增的不可逆设定变化。
## 输出要求
- 只输出【设定更新】块本身，不要正文、不要分析、不要开场白或总结
- 逐条列出：新增/成长的能力、获得或失去的物品、身份/关系变更、重大地点迁移、新登场的重要角色
- 每行固定格式：- 能力：名称（来源/触发条件/当前限制）
- 若正文中没有此类变化，输出：
【设定更新】
（无）
${NO_META}`,
    },
    { role: 'user', content: `作品：《${name}》\n现有设定簿（供比对，避免重复记录已有事实）：\n${String(memory || '').slice(0, 2000) || '（空）'}\n\n本章正文：\n${body}` },
  ], { temperature: 0.3, maxTokens: 1024, thinking, useReasoningFallback: false, prefill: '【设定更新】\n' });
  return { content: out };
}

/** 章节后处理：重写 / 扩写 / 润色 / 换风格（纯文本编辑，不动设定簿） */
export async function postProcessChapter({ name, memory, chapterIndex, title, content, mode, style, selection }) {
  const thinking = getThinking();
  const MODE_TEXT = {
    rewrite: '重写本章：在保持章节标题、情节走向、人物与既有设定的前提下，把这一章重新写一遍，文笔与结构更出色。',
    expand: '扩写：在不改变情节走向与人物行为的前提下，把内容写得更丰满：补充场景描写、对话往来、心理刻画与细节，扩写后总字数比原文增加约 50%（不少于 2500 字）。',
    polish: '润色：保持情节、对话与信息不变，优化文笔、句式节奏与画面感，删去冗余与重复，使文字更精炼耐读。',
    style: `换风格：保持情节、人物与信息不变，按用户指定风格重写：${String(style || '').trim() || '（未指定，请选择一种合适的文风）'}。`,
  };
  const target = (selection && selection.trim())
    ? `## 处理范围\n用户只选中了以下片段，只处理这段：\n${selection.trim()}`
    : '## 处理范围\n处理整章正文。';

  const sysContent = `你是资深网络小说编辑，擅长在保持原有人物、设定与情节的前提下对章节正文进行编辑加工。
- 输出必须只有处理后的正文本身：不要标题、不要【随笔】/【设定更新】、不要解释或开场白
- 严格保持与【设定簿】已确认事实一致，不得新增、篡改或遗忘设定
- 一律使用简体中文输出${thinking ? THINKING_HINT : ''}`;

  const result = await chatStream([
    { role: 'system', content: sysContent },
    { role: 'user', content: `作品：《${name}》\n第 ${chapterIndex} 章标题：${title}\n设定簿（仅作一致性参考，不要重复输出）：\n${String(memory || '').slice(0, 2000) || '（空）'}\n\n${target}\n\n任务：${MODE_TEXT[mode] || MODE_TEXT.polish}\n\n原文：\n${String(content || '').slice(0, 12000)}` },
  ], { temperature: 0.9, maxTokens: 8192, thinking, useReasoningFallback: false });
  return { content: result };
}

export async function discuss({ context, messages, onChunk }) {
  const thinking = getThinking();
  const content = await chatStream([
    { role: 'system', content:
`你是一位温和但锐利的创作导师，与作者实时讨论小说创作。
- 回答简洁有力：除了修改作品内容，回答一般不超过 300 字；可以提出尖锐问题帮助作者思考
- 如果讨论后需要修改作品内容，在回复末尾用修改标记，我会自动执行：每个标记独占一行，形如【标记名】，下一行写替换内容；正文与修改块、各修改块之间用空行分隔；标记内容会完全替换原有对应内容
- 可用标记：【修改大纲】【修改人设】【修改伏笔】【修改随笔】（修改最新章节的作者随笔备查）【修改设定】（修改设定簿，会完全替换）【修改章节：第X章】（只替换正文，X 必须是已存在的章节序号）【修改章节标题：第X章】（只替换标题）
- 只有确实需要修改时才使用标记

正确示例：
你的回复文字...

【修改人设】
张三，男，25岁，性格沉稳...

${NO_META}
当前作品资料：
${context}${thinking ? THINKING_HINT : ''}` },
    ...messages.slice(-12),
  ], { temperature: 0.8, maxTokens: 4096, thinking, onChunk, useReasoningFallback: false });
  return { content };
}

/** 整理压缩设定簿：去重、归类、控制长度，且不遗漏已确认事实 */
export async function tidyMemory({ name, memory }) {
  const thinking = getThinking();
  const content = await chatStream([
    {
      role: 'system',
      content: `你是长篇小说的设定管理员，把散乱的设定簿整理成结构清晰、无遗漏的事实档案。
## 整理要求
- 用二级标题分组：能力、物品、身份与关系、地点与时间线、未了结的线索
- 每条尽量一行，保留关键细节（来源/条件/限制），删除重复与口水话
- 总长度不超过原文的 60%，但不得遗漏任何已确认事实
- 不要把推断写成事实；拿不准的标注"（待定）"
- 只基于当前设定簿整理：不要引入、补充或推断设定簿之外的任何剧情信息
${NO_META}${thinking ? THINKING_HINT : ''}`,
    },
    { role: 'user', content: `作品：《${name}》\n当前设定簿：\n${memory || '（空）'}` },
  ], { temperature: 0.3, maxTokens: 4096, thinking, useReasoningFallback: false, prefill: '## 能力\n' });
  return { content };
}

const MEMORY_SECTIONS = ['能力', '物品', '身份与关系', '地点与时间线', '未了结的线索'];

/** 清洗抽取输出：去掉开头分析/过渡文字，只保留从第一个二级标题起的设定簿本体 */
function cleanExtractOutput(raw) {
  const text = String(raw || '').trim();
  const firstHeading = text.search(/^##\s/m);
  return (firstHeading > 0 ? text.slice(firstHeading) : text).trim();
}

/** 判断抽取结果是否合格：至少 3 个目标二级标题，且不含明显元叙述 */
function looksLikeExtract(text) {
  if (!text) return false;
  const headings = MEMORY_SECTIONS.filter((s) => new RegExp(`^##\\s*${s}`, 'm').test(text)).length;
  const meta = /(我们来|现在组织|先整理|需要输出|注意：|以下是我|好的，|开始梳理)/.test(text);
  return headings >= 3 && !meta;
}

const EXTRACT_WINDOW = 500;      // 采样窗口宽度（字）
const EXTRACT_MAX_TOTAL = 24000; // 抽取输入总上限（字）

/**
 * 均匀采样一章正文：窗口等距分布在全文（含开头与结尾），
 * 避免只取头尾导致中间出现的重要物品/技能卡被遗漏。
 */
function sampleChapter(body, budget) {
  if (body.length <= budget) return body;
  const windows = Math.max(1, Math.min(4, Math.floor(budget / EXTRACT_WINDOW)));
  const win = Math.floor(budget / windows);
  const parts = [];
  for (let i = 0; i < windows; i++) {
    const start = Math.floor((body.length - win) * i / (windows - 1));
    parts.push(body.slice(start, start + win));
  }
  return parts.join('\n……（中间省略）……\n');
}

/** 从章节正文抽取设定簿（适用于 TXT 导入等无设定簿的项目） */
export async function extractMemory({ name, chapters }) {
  const thinking = getThinking();

  const chapterList = (chapters || []).filter((c) => String(c.content || '').trim());
  if (chapterList.length === 0) {
    throw new Error('没有可抽取的章节正文');
  }

  // 每章预算按章节数自适应：章节少时尽量取全文，章节多时均匀采样
  const perChapterBudget = Math.min(4000, Math.floor(EXTRACT_MAX_TOTAL / chapterList.length));
  const items = [];
  let total = 0;
  for (let i = 0; i < chapterList.length; i++) {
    const c = chapterList[i];
    const body = String(c.content || '').trim();
    const part = `【第${c.index || i + 1}章 ${c.title || ''}】\n${sampleChapter(body, perChapterBudget)}`;
    if (total + part.length > EXTRACT_MAX_TOTAL) {
      const budget = EXTRACT_MAX_TOTAL - total;
      if (budget < 200) break;
      items.push(part.slice(0, budget));
      break;
    }
    items.push(part);
    total += part.length;
  }
  const corpus = items.join('\n\n');

  const sysPrompt = `你是长篇小说的设定管理员，负责从章节正文中抽取已确认的设定事实，生成设定簿。
## 结构要求
- 直接以 "## 能力" 开头，五个二级标题齐全且顺序固定：能力、物品、身份与关系、地点与时间线、未了结的线索
- 每条尽量一行，保留关键细节（来源/条件/限制）
- 抽卡/奖励所得（技能卡、道具、材料等）、获得或失去的物品必须逐条记入"物品"；主角获得或成长的能力、技能、系统奖励记入"能力"——这类条目宁可多列，不可遗漏
## 事实原则
- 只抽取正文中明确出现的事实，不把推断写成事实；正文缺失或前后矛盾时，直接在对应条目后标注"（待定）"
- 同一事实只记一次
${NO_META}`;

  let finishReason = null;
  const build = (extraHint) => chatStream([
    { role: 'system', content: extraHint ? `${sysPrompt}\n\n${extraHint}` : sysPrompt },
    { role: 'user', content: `作品：《${name}》\n以下是章节正文（按时间顺序，中间可能省略）：\n\n${corpus}` },
  ], {
    temperature: 0.3,
    maxTokens: 4096,
    thinking,
    useReasoningFallback: false,
    prefill: '## 能力\n',
    onFinish: (reason) => { finishReason = reason; },
  });

  const first = await build('');
  let cleaned = cleanExtractOutput(first);
  if (finishReason === 'length' || !looksLikeExtract(cleaned)) {
    // 被截断或格式不合格：用纠错提示重试一次
    finishReason = null;
    const retry = await build('上一次回复不合格（被截断或包含分析、结构不完整）。现在只输出设定簿本身：直接以 "## 能力" 开头，五个二级标题齐全，不要任何分析、过渡、开场白或总结。特别注意：抽卡/奖励所得的物品与技能卡必须列出，不得遗漏。');
    cleaned = cleanExtractOutput(retry);
  }
  return { content: cleaned };
}
