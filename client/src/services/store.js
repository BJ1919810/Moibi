const DB_KEY = 'mobin.projects.v1';

let cache = null;
/** 兼容旧数据：补齐缺失字段，避免老项目在新增功能后出现 undefined 异常 */
function normalizeProject(p) {
  return {
    ...p,
    name: p.name || '未命名作品',
    category: p.category || '未分类',
    coreIdea: p.coreIdea || '',
    outline: p.outline || '',
    characters: p.characters || '',
    foreshadowing: p.foreshadowing || '',
    memory: p.memory || '',
    characterCards: Array.isArray(p.characterCards) ? p.characterCards.map(normalizeCard) : [],
    chapters: Array.isArray(p.chapters)
      ? p.chapters.map((c) => ({
          ...c,
          title: c.title ? c.title.replace(/^(?:#+\s*)?第.+?章\s*/, '').trim() || c.title : c.title,
          notes: c.notes || '',
        }))
      : [],
    discussions: Array.isArray(p.discussions) ? p.discussions : [],
    createdAt: p.createdAt || Date.now(),
    updatedAt: p.updatedAt || Date.now(),
  };
}

/** 归一化单张角色卡：补齐缺失字段，保证前端与 AI 调用拿到的形状稳定 */
function normalizeCard(c) {
  return {
    ...c,
    id: c.id || uid(),
    name: c.name || '未命名角色',
    aliases: Array.isArray(c.aliases) ? c.aliases.map(String).filter(Boolean) : [],
    role: ['主角', '配角', '反派'].includes(c.role) ? c.role : '配角',
    gender: c.gender || '',
    age: c.age || '',
    identity: c.identity || '',
    appearance: c.appearance || '',
    personality: c.personality || '',
    motivation: c.motivation || '',
    arc: c.arc || '',
    relationships: Array.isArray(c.relationships)
      ? c.relationships.map((r) => ({ name: r?.name || '', relation: r?.relation || '', note: r?.note || '' })).filter((r) => r.name)
      : [],
    abilities: Array.isArray(c.abilities) ? c.abilities.map(String).filter(Boolean) : [],
    status: ['alive', 'dead', 'missing', 'changed'].includes(c.status) ? c.status : 'alive',
    statusNote: c.statusNote || '',
    highlight: c.highlight || '',
    sourceChapter: c.sourceChapter ?? null,
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
  };
}

const read = () => {
  if (cache) return cache;
  try {
    cache = (JSON.parse(localStorage.getItem(DB_KEY)) || []).map(normalizeProject);
  } catch {
    cache = [];
  }
  return cache;
};
const write = (projects) => {
  const prev = cache;
  cache = projects;
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(projects));
  } catch (e) {
    cache = prev; // 回滚内存缓存，避免写入失败后数据不一致
    if (e?.name === 'QuotaExceededError' || e?.code === 22) {
      throw new Error('存储空间不足：书库容量已满，请删除一些作品或章节后再试');
    }
    throw e;
  }
};
const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function newProject({ name, category, coreIdea }) {
  return {
    id: uid(),
    name,
    category: category || '未分类',
    coreIdea: coreIdea || '',
    outline: '', characters: '', foreshadowing: '', memory: '', notes: '',
    chapters: [], discussions: [], characterCards: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

const cloneProject = (p) => ({ ...p, chapters: [...p.chapters], discussions: [...p.discussions], characterCards: [...(p.characterCards || [])] });

export const store = {
  listProjects(tags) {
    const list = read();
    const selected = Array.isArray(tags)
      ? tags.filter(Boolean)
      : (tags && tags !== '全部' ? [tags] : []);
    const filtered = selected.length > 0
      ? list.filter((p) => {
          const pTags = (p.category || '').split('/').map((s) => s.trim()).filter(Boolean);
          return selected.every((t) => pTags.includes(t));
        })
      : [...list];
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  listCategories() {
    return ['全部', ...new Set(
      read().flatMap((p) => (p.category || '').split('/').map((s) => s.trim()).filter(Boolean))
    )];
  },

  createProject(body) {
    const projects = read();
    const project = newProject(body);
    projects.push(project);
    write(projects);
    return cloneProject(project);
  },

  getProject(id) {
    const p = read().find((x) => x.id === id);
    if (!p) throw new Error('项目不存在');
    return cloneProject(p);
  },

  updateProject(id, patch) {
    const projects = read();
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error('项目不存在');
    const allowed = ['name', 'category', 'coreIdea', 'outline', 'characters', 'characterCards', 'foreshadowing', 'memory', 'discussions'];
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      // 角色卡落库前归一化，保证任意写入路径都得到稳定形状
      p[k] = k === 'characterCards'
        ? (Array.isArray(patch[k]) ? patch[k].map(normalizeCard) : [])
        : patch[k];
    }
    p.updatedAt = Date.now();
    write(projects);
    return cloneProject(p);
  },

  deleteProject(id) {
    write(read().filter((p) => p.id !== id));
    return { ok: true };
  },

  addChapter(id, { title, content, notes }) {
    const projects = read();
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error('项目不存在');
    const chapter = {
      id: uid(),
      title: title || `第${p.chapters.length + 1}章`,
      content: content || '',
      notes: notes || '',
      createdAt: Date.now(),
    };
    p.chapters.push(chapter);
    p.updatedAt = Date.now();
    write(projects);
    return chapter;
  },

  /** 批量追加章节（导入时用，仅一次读写，避免 N 次全量序列化） */
  bulkAddChapters(pid, list) {
    const projects = read();
    const p = projects.find((x) => x.id === pid);
    if (!p) throw new Error('项目不存在');
    for (const ch of list) {
      p.chapters.push({
        id: uid(),
        title: ch.title || `第${p.chapters.length + 1}章`,
        content: ch.content || '',
        notes: ch.notes || '',
        createdAt: Date.now(),
      });
    }
    p.updatedAt = Date.now();
    write(projects);
    return cloneProject(p);
  },

  updateChapter(pid, cid, patch) {
    const projects = read();
    const p = projects.find((x) => x.id === pid);
    const c = p?.chapters.find((x) => x.id === cid);
    if (!c) throw new Error('章节不存在');
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.content !== undefined) c.content = patch.content;
    if (patch.notes !== undefined) c.notes = patch.notes;
    p.updatedAt = Date.now();
    write(projects);
    return cloneProject(p);
  },

  deleteChapter(pid, cid) {
    const projects = read();
    const p = projects.find((x) => x.id === pid);
    if (!p) throw new Error('项目不存在');
    p.chapters = p.chapters.filter((c) => c.id !== cid);
    p.updatedAt = Date.now();
    write(projects);
    return { ok: true };
  },
};
