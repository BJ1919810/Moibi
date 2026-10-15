/**
 * 提示词层（版本化）。
 *
 * 分层对应工程规划文档 §3：
 *   L1 全书／卷规划 → outlineMessages
 *   L3 正文写作     → 已迁至 projection.js（buildWriterMessages）
 *                     正文提示词必须与「信息投影」绑在一处，才能真正保证秘密不外流
 *   L5 记忆提取     → extractMessages（输出四类状态，供 ledger 落账）
 *
 * 秘密管理：实体的 secret / 伏笔的 payoff / 非本章的章节概要，
 * 一律不进入正文提示词；投影与泄漏自检见 projection.js。
 */

import { genrePrompt, outlinePlanCount, validateChapterCount } from './creative-options.js'

/** 偏好字段的中文名；styleSpec 是 style/tone/pace 的合并替代（见 author-control.js）。 */
const PREF_LABEL = { styleSpec: '文风设定', style: '文风', tone: '基调', pace: '节奏',
  protagonist: '主角设定', ending: '结局偏好', forbidden: '禁止描写', coreGoal: '核心目标' }

/**
 * 把偏好对象压成提示词可用的「字段：值」清单。
 *
 * 若存在合并后的 styleSpec，则**不再重复输出** style/tone/pace：
 * 三者本就重叠，同时出现会让模型收到三份互相拉扯的风格指令。
 */
function preferenceLines(preferences = {}) {
  const p = preferences || {}
  const hasSpec = typeof p.styleSpec === 'string' && p.styleSpec.trim()
  const out = []
  for (const [key, value] of Object.entries(p)) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (hasSpec && ['style', 'tone', 'pace'].includes(key)) continue
    out.push(`${PREF_LABEL[key] || key}：${value}`)
  }
  return out.join('\n') || '未额外指定'
}

/** 单测入口：直接验证偏好行的合并行为（不构造完整 prompt）。 */
export const preferenceLinesForTest = preferenceLines

export const GENRES = ['玄幻', '都市', '科幻', '悬疑', '历史', '武侠', '言情', '无限流', '游戏', '末世']

export const DEFAULT_WORD_COUNT = 2600

/* ------------------------------ L1 全书规划 ------------------------------ */

export function outlineMessages({ idea, genre, genreTags, targetChapters, preferences = {}, authorWorldRules = '' }) {
  const system = `你是资深长篇网文策划编辑，擅长把一句话灵感深化成能支撑数十万字的完整故事架构。
你的产出会直接交给写作模型使用，因此必须结构清晰、动机合理、可执行。
你必须严格区分「读者此刻能看到的信息」与「作者才知道的真相」——下面把它们拆成了不同字段，绝不可混放。`

  // 用户手填的世界观优先于模型自拟：它是最强的作者意图，必须原样遵守。
  const givenWorld = String(authorWorldRules || '').trim()
  // 用户手填的文风同样优先；未填时要求模型主动生成（见下方硬性要求）。
  // 兼容旧字段 styleSpec（合并字段）与新字段 style。
  const userStyle = String(preferences?.styleSpec || preferences?.style || '').trim()

  // 章节规模由用户参数决定，卷数交给规划器按规模分配（不再硬编码上限）
  const target = validateChapterCount(targetChapters ?? 30)
  const plannedNow = outlinePlanCount(target)
  const volumeHint =
    target <= 3
      ? '建议仅 1 卷'
      : target <= 28
      ? '建议分 2 至 3 卷'
      : target <= 45
        ? '建议分 3 至 4 卷'
        : target <= 80
          ? '建议分 4 至 5 卷'
          : '建议分 5 至 8 卷'

  const user = `灵感：「${idea}」
题材分层（主背景优先，机制和情绪是辅助标签，可合理融合）：
${genrePrompt(genreTags, genre)}
【作者明确偏好（最高优先级；未指定字段允许自由发挥）】
${preferenceLines(preferences)}
${givenWorld ? `\n【作者已确定的世界观（最高优先级，必须原样遵守，不得改写或与之冲突）】\n${givenWorld}\n` : ''}

请为这部长篇小说设计完整的故事架构。硬性要求：

1. 以主背景建立稳定世界规则，机制、情感基调和补充标签可以兼容叠加。多选不视为异质元素；不得自行引入未选且破坏世界规则的力量体系。
2. 采用三幕结构：每一幕写清情节梗概与它在整体中的叙事功能，讲明主角的处境如何被逐步改变。
3. **规模**：用户目标全书 ${target} 章，${volumeHint}；本次 JSON 的 volumes[].chapters **建议规划开篇约 ${plannedNow} 章**（从第1章开始连续；目标较长时允许在 3～5 章范围内浮动），后续章节由滚动 L2 按需细化。三幕与分卷目标必须概括全书走向而不是只写开头。不要为了凑章节数重复剧情，不得尝试一次输出全部 ${target} 章。若目标只有1章，只安排1章、1卷。
4. 每一章必须有明确、可验证的目标——说清「这一章结束时，什么发生了变化」。禁止出现「本章精彩一点」「推进剧情」这类空话。
5. 每一章都要标注本章允许正式出场或被提及的人物（cast，最多 4 人）。**未列入的角色不得在该章出场或介入剧情**，这是硬约束。
6. 主要角色 4 至 6 人。每个角色提供作者侧人物卡，但必须把信息拆成两类，绝不可混放：
   - publicRole / publicIdentity：**读者在这一刻就能看到、能观察到**的部分（外在身份、年龄、行为习惯）。不要写任何秘密。
   - authorRole / secret / want / fear：作者视角的信息（结构定位、隐藏真相、真实动机）。这部分**不会**交给写作模型。
   角色没有秘密时，secret 写 null。
7. 设计 3 至 5 条伏笔并编号（f1、f2…），写清表层线索（seed）、真实含义（payoff）、计划铺设章节（plantAt，填章号）与计划回收章节（revealAt，填章号）。
8. 主角必须有一个贯穿全书的、具体的目标；反派的动机必须成立，不能只是为了作恶而作恶。
9. **世界观（worldview）**：**必填**。写清这个世界的时代与地理、主要场所、社会或组织形态、力量体系（若有）、读者从第 1 章起就该默认成立的常识与禁忌。非玄幻题材同样要写现实世界的具体设定（城市、学校、行业、机构）。**不得把未公开真相写进 worldview**——它是公开设定，不是谜底。${givenWorld ? '' : '用户未提供世界观，这正是需要你补足的地方：请根据灵感与题材自行设定一套具体、可长期沿用的世界观。'}
10. **文风（style）**：**必填**。写清叙述人称与视角、意象偏好、对话风格。${userStyle ? '' : '用户未填写文风，请根据题材与灵感气质自行设定一种明确、可执行的文风，不要省略。'}
11. **作者偏好补充（preferences）**：**四项全部必填，每项都要写出具体内容**：
   - coreGoal（核心目标）：主角贯穿全书追求的那个具体目标，写成一句可验证的话。
   - forbidden（禁止描写）：本书**明确不写**的内容与写法（例如「不写穿越、不出现系统面板、不用第二人称」）。必须给出至少两条真正的禁忌。
   - ending（结局偏好）：结局的走向与情感落点（例如「开放式但偏向和解」「牺牲换取新生」），一句话说清。
   - protagonist（主角设定）：主角的一句话人物定位（性格 + 处境的浓缩）。

**填充质量的硬性要求（违反即视为无效输出）**：
- 以上 worldview / style / preferences 四项，**只要用户没有明确给出，就必须由你主动生成完整内容**；用户没填不等于可以留空。
- **严禁**输出空字符串、null、"待定"、"暂无"、"略"、"同上"、"未提供"、"由用户决定"、"稍后补充"等占位或敷衍内容。
- 每一项都必须是**这一部作品专属**的具体内容，能直接拿来指导写作，不能是放之四海皆准的空话。

只输出 JSON，不要任何解释文字，不要 Markdown 代码块。格式如下：

{
  "title": "书名，不超过 8 字，有意境",
  "logline": "作者视角的一句话梗概，40字以内，可包含未公开真相",
  "readerLogline": "正文可读的表层简介，不包含任何未来真相，40字以内",
  "readerTheme": "正文可读的公开主题，不含未来真相",
  "theme": "作品的核心主题，一句话",
  "worldview": "这个世界的基础规则设定：时代背景、地点、社会或组织形态、力量体系（若有）、约定俗成的禁忌与常识。只写读者在第 1 章就能感知的层面，不得写入未公开真相；180 字以内。必填，不得为空或占位",
  "style": "文风设定：叙述人称与视角、意象偏好、对话风格，80 字以内。必填，不得为空或占位${userStyle ? '（用户已指定，必须原样沿用，不得改写）' : ''}",
  "preferences": {
    "coreGoal": "主角贯穿全书要达成的具体目标，一句话，必填",
    "forbidden": "本书明确不写的内容与写法，至少两条，用分号隔开，必填",
    "ending": "结局走向与情感落点，一句话，必填",
    "protagonist": "主角的一句话人物定位（性格＋处境），必填"
  },
  "acts": [
    { "name": "第一幕", "summary": "情节梗概", "function": "叙事功能" },
    { "name": "第二幕", "summary": "情节梗概", "function": "叙事功能" },
    { "name": "第三幕", "summary": "情节梗概", "function": "叙事功能" }
  ],
  "cast": [
    {
      "name": "角色名",
      "publicRole": "读者此刻眼中的身份，例如「档案馆志愿者」「调查记者」",
      "publicIdentity": "读者此刻能观察到的一切：年龄、职业、外在特征、行为习惯。不要写任何秘密",
      "authorRole": "主角 / 女主 / 对手 / 配角（仅供结构判断，不给写作模型看）",
      "secret": "隐藏的真相与真实动机。读者此刻不应知道的内容全部写在这里；没有秘密则写 null",
      "want": "驱动他行动的根本欲望（作者视角，不给写作模型看）",
      "fear": "他恐惧什么（作者视角，不给写作模型看）",
      "gender": "性别或未知",
      "age": "年龄或未知",
      "appearance": "可观察外貌",
      "personality": "主要性格（含缺点）",
      "motivation": "真实动机，仅作者视角",
      "arc": "人物弧光与终点，仅作者视角",
      "relationships": [{"name":"相关角色","relation":"关系","note":"作者侧备注"}],
      "abilities": "能力；未说明时不擅自引入",
      "status": "当前状态，不写未来结局",
      "highlight": "重要未来节点，仅作者视角"
    }
  ],
  "reveals": [{ "entityId": "本章正式允许揭示的实体ID", "projectionId": "对应审核过的表层披露ID", "evidence": "正文中真实出现的引文" }],

  "foreshadows": [
    {
      "id": "f1",
      "seed": "埋下的表层线索（写作时呈现给读者的部分）",
      "payoff": "真实含义与回收计划（绝不给写作模型看）",
      "plantAt": 10,
      "revealAt": 26
    }
  ],
  "volumes": [
    {
      "title": "卷名",
      "goal": "本卷要达成的阶段性目标",
      "chapters": [
        {
          "title": "章标题",
          "summary": "本章作者侧完整情节（可能含真相），80 字以内",
          "writerSummary": "严格不包含未来秘密的本章表层动作方案",
          "writerGoal": "只写本章读者可观察到的验收目标",
          "goal": "本章结束时的可验证变化",
          "cast": ["本章允许正式出场或被提及的角色名，最多 4 人"],
          "foreshadows": [{ "id": "f1", "action": "plant" }]
        }
      ]
    }
  ]
}

foreshadow 的 action 只能是 plant（铺设）、reinforce（强化）、pay_off（回收）三者之一。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/* ---------------------------- L1-b 设定兜底补全 ---------------------------- */

/**
 * 当开书时大纲模型**没有**按要求给出世界观 / 文风 / 作者偏好时，
 * 单独跑这一次「补全」调用把它们补上（用户已选「两者结合」策略）。
 *
 * 与 outlineMessages 的区别：这里只输出那几项设定，不重新规划剧情，
 * 成本低、也不触碰已经生成好的大纲与角色。
 */
export function settingsFillMessages({ idea, genre, genreTags, targetChapters, preferences = {}, title = '', givenWorld = '' }) {
  const system = `你是长篇小说设定师。你只负责补齐「设定层」内容，不写剧情、不列大纲。
你的输出必须是具体、可长期沿用、能直接指导写作的内容，绝不能是放之四海皆准的空话。`

  const user = `这是一部长篇小说的基本信息：
灵感：「${idea}」
题材分层：
${genrePrompt(genreTags, genre)}
书名：${title || '（未定）'}
${givenWorld ? `已确定的世界观（不得改写，只能在此基础上补充）：\n${givenWorld}\n` : ''}
已有设定（若有，视为已确定，不得改写）：
${preferenceLines(preferences)}

请补齐下列**仍然空缺**的设定项，每项都要写出具体内容：

1. worldview：时代与地理、主要场所、社会或组织形态、力量体系（若有）、读者从第 1 章起就该默认成立的常识与禁忌。不得写入未公开真相（它是公开设定，不是谜底）。
2. style：叙述人称与视角、意象偏好、对话风格。
3. coreGoal：主角贯穿全书要达成的具体目标。
4. forbidden：本书明确不写的内容与写法，至少两条，用分号隔开。
5. ending：结局走向与情感落点。
6. protagonist：主角的一句话人物定位（性格＋处境）。

硬性要求：
- 上面已经给出内容的项，在输出里原样回填，不要改写。
- 真正空缺的项，必须由你生成完整内容，不是复述。
- **严禁**输出空字符串、null、"待定"、"暂无"、"略"、"同上"、"未提供"、"由用户决定"等占位或敷衍内容。

只输出 JSON，不要任何解释文字，不要 Markdown 代码块：
{
  "worldview": "…",
  "style": "…",
  "preferences": { "coreGoal": "…", "forbidden": "…", "ending": "…", "protagonist": "…" }
}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/* ------------------------------ L5 记忆提取 ------------------------------ */

/**
 * 输出四类状态，直接对应 ledger 的四张表。
 * states 与 knowledge 记录的是「可逆但构成下一章前提」的信息 ——
 * 它们此前被「只记不可逆事实」的设计排除在外，是账本失效的根因之一。
 */
export function extractMessages(chapterText, chapterNo, ctx = {}) {
  const system = `你是小说设定的记录员。你只记录正文中明确写出的内容，绝不推断、不发挥、不补充。`

  // ⛔ 真实踩坑（v2.0.0 全量 30 章压测）：提示词要求 `foreshadowId` 填「大纲中既有伏笔 ID」，
  //    却**从来没有把伏笔清单喂给模型** ⇒ 模型根本不知道 f1~f5 存在 ⇒ `foreshadows` 恒为空数组
  //    ⇒ `ledger.foreshadowEvents` 恒为空 ⇒ `revealDecision()` 永远 `not-planted`
  //    ⇒ 任何带伏笔的书**写到第一个回收章就永久卡死**（17 章 0 条铺设事件就是铁证）。
  //    所以这里必须把「ID 清单 + 本章允许的动作」显式列出来。
  const catalog = Array.isArray(ctx.foreshadows) ? ctx.foreshadows.filter((f) => f && f.id) : []
  const allowed = Array.isArray(ctx.plannedActions) ? ctx.plannedActions.filter((a) => a && a.id && a.action) : []
  const foreshadowBlock = catalog.length ? `

【本作伏笔清单 —— foreshadows[].foreshadowId 只能填下面这些 ID，禁止自造任何新 ID】
${catalog.map((f) => `· ${f.id}：${String(f.seed || '').slice(0, 90)}` +
    `（计划第 ${f.plantChapter ?? '?'} 章埋、第 ${f.payoffChapter ?? '?'} 章回收）`).join('\n')}

本章（第 ${chapterNo} 章）**允许输出的伏笔动作只有**：${
    allowed.length ? allowed.map((a) => `${a.id} → ${a.action}`).join('、')
      : '（本章没有计划任何伏笔动作）'}${allowed.length ? '' : '\n⚠️ 因此本章的 foreshadows **必须输出空数组 []**。'}
- 动作必须与上面列出的**完全一致**（写别的动作会被丢弃）。
- 只有正文里**真的写到了**该线索、并能逐字抄出连续原文时才输出；没写到就整条不要输出。
${allowed.some((a) => a.action === 'pay_off') ? '- ✅ 本章的 `pay_off` **已经由作者授权**（作者在伏笔面板确认过这条线可以在本章回收）：如果正文确实把这条伏笔揭开了，就照实输出 pay_off，并附上连续原文作证据；没写到就整条不要输出。' : '- ⛔ **不要输出 pay_off**：回收是否允许由作者单独授权，不由你决定。'}` : ''

  // ⛔ 真实踩坑（v2.0.0 全量 30 章压测 · 主人指出「模型会自己没完没了地加更多的伏笔」）：
  //    这条提示词此前**只问「本章新埋下的线索」**，既不给「已有线索清单」，
  //    也不要求模型报"了结" ⇒ 模型每章只顾着新埋 ⇒ 实测 25 章累计 **82 条线索全部 open**，
  //    `resolved` 全程只产出过 1 条。而未了结清单进上下文时上限只有 20 条、且按章号降序，
  //    于是第 1~19 章埋的线索**全被挤出**、模型再也看不见 ⇒ 「前后矛盾」。
  //    修法：把两个清单（未了结 / 已了结）显式喂给模型，并**强制要求「了结的必须报」**，
  //    让线索集合能收能敛，而不是只增不减。
  const openThreads = (Array.isArray(ctx.existingThreads) ? ctx.existingThreads : []).filter(Boolean)
  const closedThreads = (Array.isArray(ctx.closedThreads) ? ctx.closedThreads : []).filter(Boolean)
  const threadListBlock = openThreads.length || closedThreads.length ? `

【本作已有线索清单 —— 先看这里，再决定 threads 里该写什么】
· 尚未了结：
${openThreads.length ? openThreads.map((t) => `  - ${t}`).join('\n') : '  （无）'}${closedThreads.length ? `
· 已经了结：
${closedThreads.map((t) => `  - ${t}`).join('\n')}` : ''}

- threads 数组**只填上面任何一条都没有的、本章真正新出现的**线索；与清单里重复的**一律不要输出**。
- 上面「已经了结」的内容**绝对不要**再当作新线索输出。
- 本章如有线索被解决、被揭开、或明确不再悬着，**必须**把清单里对应的那条**原文照抄**进 resolved
  —— 这是让线索清单收敛的唯一途径。没有就输出空数组 []，不要硬凑。` : ''

  const user = `请阅读下面这一章正文，整理出需要进入长期记忆的内容。

【正文】
${chapterText}
${foreshadowBlock}${threadListBlock}

只输出 JSON，不要任何解释文字。格式：

{
  "summary": "本章摘要，200 字以内。写清发生了什么、谁的态度或处境发生了什么变化",

  "facts": [
    { "text": "本章确立的稳定事实", "evidence": "逐字摘自本章正文的原文短引文" }
  ],

  "states": [
    { "subject": "角色名", "attribute": "持有 / 位置 / 伤势 / 关系", "value": "具体内容", "evidence": "逐字摘自本章正文的短引文" }
  ],

  "knowledge": [
    { "character": "角色名", "fact": "他此刻知道或相信的具体内容", "belief": "knows / believes / suspects", "evidence": "逐字摘自本章正文的短引文" }
  ],

  "threads": [{ "text": "本章新埋下的表层线索", "evidence": "正文中的连续原文短引文" }],

  "reveals": [{ "entityId": "本章正式允许揭示的实体ID", "projectionId": "对应审核过的表层披露ID", "evidence": "正文中真实出现的引文" }],

  "foreshadows": [
    { "foreshadowId": "大纲中既有伏笔 ID", "action": "plant/reinforce/pay_off", "evidence": "必须逐字摘自本章正文的连续短引文，若未实际写到则不要输出" }
  ],

  "resolved": ["本章已明确了结的旧线索"]
}

判断标准：
- 只记录正文中明确出现的内容。推断出来的、读者可能猜到的都不算。
- **states 专门记录可逆但影响后续的变化**：某人拿到了什么、受了什么伤、去了哪里、与谁的关系变成什么样。
  这类信息哪怕下一章就会改变，也必须记录 —— 它是下一章的写作前提。
- knowledge 只记录角色对信息的掌握情况：谁知道、谁误信、谁在怀疑。
- 每条 states/knowledge 必须给出在原文中能逐字查到的 evidence，没有证据则不要输出。
- 事实与线索缺证据会被隔离，不能进入后续正式上下文。
- 伏笔只提取本章真实出现的表层证据，必须给出正文原文短引文；绝不可因为大纲计划写了，就标记已经铺设或回收。
  「foreshadowId」只能取提示中**已列出**的伏笔 ID，动作只能取提示中列出的「允许输出的伏笔动作」；
  提示没给清单、或本章没有允许的动作时，foreshadows 一律输出空数组 []。
- 普通生活细节（天气、路人、陈设）不必记录。
- 篇幅宁缺毋滥：facts 最多 5 条，states 最多 5 条，knowledge 最多 5 条。

【evidence 的严格写法 —— 会被逐字核对，写错这条记录就作废】
- **整段原样复制**正文里的连续文字（建议 15～40 字），一个字都不要改、不要缩略、不要改写标点。
- **不要自己加引号、书名号或括号**。直接抄原句本身即可：
    ✅ 她转过身，从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。
    ❌ “她转过身，从书架上抽出一个新的牛皮纸本，放在桌上，推到我面前。”
- **不要用省略号省略或拼接**。不要把「隔着叙述句的前后半句」拼成一句：
    ❌ 这四天，门都自己开了。但只有昨天，有人进来了。   （中间其实还夹着「林晚把册子合上」）
    ✅ “这四天，”林晚把册子合上，“门都自己开了。但只有昨天，有人进来了。”
- **不要用太短的句子**（如「你。」「嗯。」这种一两个字的对白）当证据 ——
  换一段更长、能独立说明问题的连续原文；实在找不到合适的，就不要输出这条。
- 如果某条变化找不到符合上述要求的连续原文，**宁可不输出这一条**，也不要凑一个近似的句子。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
