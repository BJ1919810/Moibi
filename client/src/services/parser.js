/**
 * 解析短篇 TXT 小说，自动识别章节结构。
 * 限制：不超过 500KB，否则跳过解析仅作为"未分类"内容导入。
 */

/**
 * 章节标题正则：要求整行不超过 40 字、且不以句号/感叹号/问号/省略号结尾，
 * 避免把正文里以"第X章"开头的长句误判成章节。
 */
const CHAPTER_RE = /^(?=[^\n]{0,40}$)(?!.*[。！？!?…]$)(?:第\s*[\u4e00-\u9fa5\d]+\s*[章节回部]|Chapter\s+\d+|CHAPTER\s+\d+)\s*[：:.\s]*(.*)$/gm;
/** 非全局版本，用于单行 test，避免 g 标志污染 lastIndex */
const CHAPTER_TEST_RE = /^(?=[^\n]{0,40}$)(?!.*[。！？!?…]$)(?:第\s*[\u4e00-\u9fa5\d]+\s*[章节回部]|Chapter\s+\d+|CHAPTER\s+\d+)\s*[：:.\s]*(.*)$/;

/**
 * 解析 TXT 文本，返回可用于 store.createProject / store.addChapter 的数据。
 * @param {string} raw - 文件原始文本
 * @param {string} filename - 文件名（用于提取默认书名）
 * @returns {{ project: { name, coreIdea }, chapters: Array<{title, content}> }}
 */
export function parseTxt(raw, filename) {
  // 兼容 ArrayBuffer 入参，并去掉可能残留的 BOM（\uFEFF）
  const text = (typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw)).replace(/^\uFEFF/, '');

  const lines = text.split(/\r?\n/);
  const trimmed = lines.map((l) => l.trim()).filter(Boolean);

  if (trimmed.length === 0) {
    throw new Error('文件内容为空');
  }

  // --- 提取书名：第一行非空行（去除《》包裹） ---
  let title = trimmed[0].replace(/^[《「"']|[》」"']$/g, '').trim();
  // 如果第一行像章节标题，或过长（更像正文段落），则用文件名作为书名
  if (CHAPTER_TEST_RE.test(title) || title.length > 30) {
    title = filename.replace(/\.txt$/i, '').trim() || '未命名作品';
  }

  // --- 提取核心想法：第二行（如果非空且不像章节标题） ---
  let coreIdea = '';
  if (trimmed.length > 1 && !CHAPTER_TEST_RE.test(trimmed[1])) {
    coreIdea = trimmed[1].slice(0, 100);
  }

  // --- 分割章节 ---
  const chapters = splitChapters(text);

  return {
    project: { name: title, coreIdea, category: '导入作品' },
    chapters,
  };
}

function splitChapters(text) {
  // 使用正则匹配章节标题
  const matches = [];
  let match;

  // 重置正则
  CHAPTER_RE.lastIndex = 0;

  while ((match = CHAPTER_RE.exec(text)) !== null) {
    matches.push({
      title: (match[1] || match[0].replace(/^第[\u4e00-\u9fa5\d]+[章节回部]\s*/, '')).trim() || match[0].trim(),
      index: match.index,
      raw: match[0],
    });
  }

  // 如果没有匹配到章节，整篇作为一章
  if (matches.length === 0) {
    const clean = text.replace(/^\s+|\s+$/g, '');
    return [{ title: '正文', content: clean }];
  }

  // 分割内容
  const result = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].raw.length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(start, end).replace(/^\s+|\s+$/g, '');

    // 跳过空章节
    if (!content) continue;

    result.push({
      title: matches[i].title || `第${i + 1}章`,
      content,
    });
  }

  return result.length > 0 ? result : [{ title: '正文', content: text.replace(/^\s+|\s+$/g, '') }];
}

/**
 * 解析 AI 续写输出，分离正文、【随笔】与【设定更新】三个块。
 * 约定输出顺序：正文 → 【随笔】 → 【设定更新】（最后）。
 * @param {string} content - AI 返回的完整章节内容
 * @returns {{ cleanContent: string, notes: string, stateUpdate: string }}
 */
export function parseChapterOutput(content) {
  const blockRe = (name) => new RegExp(`【${name}】[ \\t]*\\n?([\\s\\S]*?)(?=\\n\\s*【[^】]+】|$)`);

  const stateMatch = content.match(blockRe('设定更新'));
  const notesMatch = content.match(blockRe('随笔'));

  let cleanContent = content;
  if (stateMatch) cleanContent = cleanContent.replace(stateMatch[0], '');
  if (notesMatch) cleanContent = cleanContent.replace(notesMatch[0], '');
  cleanContent = cleanContent.trim();

  const stateUpdate = stateMatch ? stateMatch[1].trim() : '';
  const notes = notesMatch ? notesMatch[1].trim() : '';
  return { cleanContent, notes, stateUpdate };
}

/** 元话术开头的保守匹配：仅当正文开头几行出现"好的，我…""让我先…"等明显元话术时命中 */
const META_OPEN_RE = /^(好的|好|嗯|行|没问题|让我|我需要|首先|根据|明白了|收到|了解|知道了)[，。:：、!！?？\s]/;

/**
 * 判断章节正文是否以元话术开头（含标题行之前的废话，如"好的，我先看看需求\n第X章 标题"）。
 * 用于触发一次带纠错提示的重新生成。
 * @param {string} cleanContent - 已去除【随笔】/【设定更新】块的正文
 */
export function hasMetaOpening(cleanContent) {
  const lines = String(cleanContent || '').trim().split('\n');
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    return META_OPEN_RE.test(line);
  }
  return false;
}

/** 文档生成异常检测：输出混入“修正 / 整理 / 归档 / 重新发布”等过程性文字时视为失控 */
const DOC_GARBLE_RE = /(以下完整发布|进入整删|最终修正|恢复正常|重新整理|重新输出|重新生成|清理分隔|规整最终|修复打叠|纯更正|过渡限|不再出现游离|整理规则|转录边界|无粘连|汇总字段|修正文字|归档)/;

/** 判断文档生成结果是否混入了自我修复类异常文字（触发一次自动重试） */
export function hasGarbledDoc(text) {
  return DOC_GARBLE_RE.test(String(text || ''));
}

/** 折叠开头连续重复的相同行（prefill 前缀与模型重复输出同一标题时用） */
export function dedupeLeadingLines(text) {
  const lines = String(text || '').split('\n');
  const first = lines[0]?.trim();
  if (!first) return String(text || '');
  let i = 1;
  while (i < lines.length && lines[i].trim() === first) i++;
  if (i > 1) lines.splice(1, i - 1);
  return lines.join('\n').trim();
}

/**
 * 把本章【设定更新】合并进项目级设定簿。
 * 无变化（空 / 仅“（无）”）时不改动原设定簿。
 * 设定簿上限 8000 字，超出时截断旧内容并提示用“AI 整理”压缩。
 * @param {string} existing - 现有设定簿
 * @param {string} update - 本章【设定更新】块内容
 * @param {number} chapterNo - 当前章节号
 * @returns {string} 合并后的设定簿
 */
export function mergeMemory(existing, update, chapterNo) {
  const text = (update || '').replace(/^【设定更新】\s*/, '').trim();
  if (!text || /^[（(]?无[)）]?$/.test(text)) return existing || '';

  const block = `【第${chapterNo}章】\n${text}`;
  const next = existing ? `${existing.replace(/\s+$/, '')}\n\n${block}` : block;
  const MAX_LEN = 8000;
  if (next.length <= MAX_LEN) return next;
  return `…（设定簿过长，旧内容已截断，可在“设定簿”页点“AI 整理”压缩）\n\n${next.slice(-MAX_LEN)}`;
}
