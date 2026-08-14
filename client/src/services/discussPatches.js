/** 中文数字 → 阿拉伯数字（兼容"第三章""第 3 章"等写法） */
const CH_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function chineseToNum(str) {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  if (!/^[零一二三四五六七八九十百]+$/.test(str)) return NaN;
  let total = 0;
  let section = 0;
  for (const ch of str) {
    if (ch === '百') { total += (section || 1) * 100; section = 0; }
    else if (ch === '十') { total += (section || 1) * 10; section = 0; }
    else section = section * 10 + (CH_DIGITS[ch] ?? 0);
  }
  return total + section || 1;
}

/**
 * 解析创作导师回复中的修改标记。
 * 容错：标签后允许同行内容；章节号兼容中文数字与空格；
 * 【修改章节】只替换正文（自动剥掉模型顺带写的"第X章 标题"行）；
 * 【修改章节标题】只替换标题。
 * @returns {{ reply: string, cards: Array, apply: Object }}
 */
export function parsePatches(content, project) {
  const RE = /【(修改大纲|修改人设|修改伏笔|修改随笔|修改设定|修改章节标题[：:]第\s*([\d零一二三四五六七八九十百]+)\s*章|修改章节[：:]第\s*([\d零一二三四五六七八九十百]+)\s*章)】[ \t]*\n?([\s\S]*?)(?=\n\s*【[^】]+】|$)/g;
  const cards = [];
  const apply = { chapters: [], chapterTitles: [] };
  const reply = content
    .replace(RE, (_m, tag, titleNum, bodyNum, body) => {
      const val = body.trim();
      if (!val) return '';
      const pushCard = (label, note) => cards.push({
        label: note ? `${label}（${note}）` : label,
        body: val,
        applied: false,
      });

      if (tag === '修改大纲') { apply.outline = val; pushCard('修改大纲'); }
      else if (tag === '修改人设') { apply.characters = val; pushCard('修改人设'); }
      else if (tag === '修改伏笔') { apply.foreshadowing = val; pushCard('修改伏笔'); }
      else if (tag === '修改随笔') { apply.notes = val; pushCard('修改随笔（最新章）'); }
      else if (tag === '修改设定') { apply.memory = val; pushCard('修改设定（设定簿）'); }
      else if (tag.startsWith('修改章节标题')) {
        const idx = chineseToNum(titleNum) - 1;
        if (!Number.isNaN(idx) && idx >= 0 && idx < project.chapters.length) {
          const titleVal = val.split('\n').map((l) => l.trim()).find(Boolean) || '';
          apply.chapterTitles.push({ idx, title: titleVal.replace(/^(?:#+\s*)?(?:第.+?章\s*)+/, '') });
          pushCard(`修改章节标题：第${titleNum}章`);
        } else {
          pushCard(`修改章节标题：第${titleNum}章`, '未应用：章节不存在');
        }
      }
      else if (tag.startsWith('修改章节')) {
        const idx = chineseToNum(bodyNum) - 1;
        if (!Number.isNaN(idx) && idx >= 0 && idx < project.chapters.length) {
          // 只替换正文；若模型顺带写了"第X章 标题"行，剥掉
          const contentOnly = val.replace(/^(?:\s*#+\s*)?第.+?章[^\n]*\n?/, '').trim();
          apply.chapters.push({ idx, content: contentOnly });
          pushCard(`修改章节：第${bodyNum}章`);
        } else {
          pushCard(`修改章节：第${bodyNum}章`, '未应用：章节不存在');
        }
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { reply, cards, apply };
}
