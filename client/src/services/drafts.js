/**
 * 续写草稿存储：生成中断/停止时保留 AI 已输出的部分，下次可保存为章节或丢弃。
 * 结构：{ [projectId]: { chapterIndex, hint, text, updatedAt } }
 */
const KEY = 'moibi.drafts.v1';
let cache = null;

const read = () => {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    cache = {};
  }
  return cache;
};

const write = (map) => {
  cache = map;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch { /* 草稿写失败不阻断主流程 */ }
};

export const saveDraft = (projectId, draft) => {
  const map = read();
  map[projectId] = draft;
  write(map);
};

export const loadDraft = (projectId) => read()[projectId] || null;

export const clearDraft = (projectId) => {
  const map = read();
  if (map[projectId]) {
    delete map[projectId];
    write(map);
  }
};
