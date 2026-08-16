/**
 * 角色卡（结构化角色设定）：渲染 / 旧文本转换 / 单卡备份格式。
 * 角色卡是项目内 "characterCards" 字段的规范形状，AI 上下文里仍以 Markdown 文本
 * （renderCardsToText 的输出）注入，保证大纲 / 伏笔 / 续写 / 讨论等模块零改动。
 */

const ROLE_GROUP = { 主角: '主角团', 配角: '配角群', 反派: '反派/对立面' };
const STATUS_TEXT = { alive: '存活', dead: '死亡', missing: '失踪', changed: '已变化' };
const ROLE_ORDER = ['主角', '配角', '反派'];

const uid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 新建一张空角色卡（不含 id，由调用方落库时生成） */
export function blankCard() {
  return {
    name: '', aliases: [], role: '配角', gender: '', age: '',
    identity: '', appearance: '', personality: '', motivation: '', arc: '',
    relationships: [], abilities: [], status: 'alive', statusNote: '',
    highlight: '', sourceChapter: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

/** 角色卡数组 → 供 AI 上下文 / 旧字段兼容用的 Markdown 文本（按角色分组） */
export function renderCardsToText(cards) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return '';
  const grouped = {};
  for (const c of list) {
    const key = ROLE_ORDER.includes(c.role) ? c.role : '配角';
    (grouped[key] = grouped[key] || []).push(c);
  }
  const lines = [];
  for (const role of ROLE_ORDER) {
    const g = grouped[role];
    if (!g || !g.length) continue;
    lines.push(`## ${ROLE_GROUP[role]}`);
    for (const c of g) {
      lines.push(`### ${c.name}${c.aliases?.length ? `（${c.aliases.join('、')}）` : ''}`);
      if (c.identity) lines.push(`- 身份/称号：${c.identity}`);
      if (c.gender || c.age) lines.push(`- 性别/年龄：${[c.gender, c.age].filter(Boolean).join(' / ')}`);
      if (c.appearance) lines.push(`- 外貌特征：${c.appearance}`);
      if (c.personality) lines.push(`- 性格：${c.personality}`);
      if (c.motivation) lines.push(`- 核心动机：${c.motivation}`);
      if (c.arc) lines.push(`- 人物弧光：${c.arc}`);
      if (c.abilities?.length) lines.push(`- 能力：${c.abilities.join('、')}`);
      if (c.relationships?.length) {
        lines.push(`- 关系网：${c.relationships.map((r) => `${r.name}（${r.relation}${r.note ? '：' + r.note : ''}）`).join('、')}`);
      }
      const st = STATUS_TEXT[c.status] || '存活';
      lines.push(`- 状态：${st}${c.statusNote ? `（${c.statusNote}）` : ''}`);
      if (c.highlight) lines.push(`- 高光时刻：${c.highlight}`);
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

/* ---------------- 旧版角色设定文本 → 角色卡（best-effort） ---------------- */

// 容忍 Markdown 列表前缀（- / *）、加粗（**标签**）与“身份/称号”连写
const LABEL_FIELDS = [
  [/^(?:[-*]\s*)?(?:\*\*)?(?:身份\/称号|身份|称号)(?:\*\*)?\s*[：:]\s*(.+)$/m, 'identity'],
  [/^(?:[-*]\s*)?(?:\*\*)?(?:外貌特征|外貌|形象)(?:\*\*)?\s*[：:]\s*(.+)$/m, 'appearance'],
  [/^(?:[-*]\s*)?(?:\*\*)?性格(?:\*\*)?\s*[：:]\s*(.+)$/m, 'personality'],
  [/^(?:[-*]\s*)?(?:\*\*)?(?:核心动机|动机)(?:\*\*)?\s*[：:]\s*(.+)$/m, 'motivation'],
  [/^(?:[-*]\s*)?(?:\*\*)?(?:人物弧光|弧光)(?:\*\*)?\s*[：:]\s*(.+)$/m, 'arc'],
  [/^(?:[-*]\s*)?(?:\*\*)?能力(?:\*\*)?\s*[：:]\s*(.+)$/m, 'abilities'],
  [/^(?:[-*]\s*)?(?:\*\*)?关系(?:网)?(?:\*\*)?\s*[：:]\s*(.+)$/m, 'relationships'],
  [/^(?:[-*]\s*)?(?:\*\*)?(?:高光时刻|高光)(?:\*\*)?\s*[：:]\s*(.+)$/m, 'highlight'],
];

const splitList = (s) => String(s || '').split(/[、，,；;]/).map((x) => x.trim()).filter(Boolean);

function sectionToCard(name, body) {
  const card = { name: String(name || '').replace(/[《》「」【】（）()]/g, '').trim() || '未命名角色', aliases: [], role: '配角', gender: '', age: '', identity: '', appearance: '', personality: '', motivation: '', arc: '', relationships: [], abilities: [], status: 'alive', statusNote: '', highlight: '' };
  const lines = body || '';
  for (const [re, key] of LABEL_FIELDS) {
    const m = lines.match(re);
    if (m) {
      const val = m[1].trim();
      if (key === 'abilities') card.abilities = splitList(val);
      else if (key === 'relationships') {
        card.relationships = splitList(val).map((x) => {
          const mm = x.match(/^(.+?)[（(]([^）)]+)[)）](?:[:：](.*))?$/);
          return mm ? { name: mm[1].trim(), relation: mm[2].trim(), note: (mm[3] || '').trim() } : { name: x, relation: '', note: '' };
        }).filter((r) => r.name);
      }
      else card[key] = val;
    }
  }
  // 没有可识别字段时，整段放进性格，避免丢信息
  if (!card.identity && !card.personality && !card.motivation && !card.appearance && !card.arc) {
    card.personality = lines.replace(/^[-*]\s*/gm, '').trim().slice(0, 500);
  }
  return card;
}

/** 把旧版 Markdown 角色设定文本拆成角色卡数组（尽力而为，UI 需提示逐张检查） */
export function parseLegacyCharacters(text) {
  const src = String(text || '').trim();
  if (!src) return [];
  const cards = [];

  // 优先按 "## 角色名" / "### 角色名" 分段
  const headRe = /^#{2,3}\s+(.+?)\s*$/gm;
  const heads = [];
  let m;
  while ((m = headRe.exec(src)) !== null) {
    heads.push({ name: m[1], index: m.index + m[0].length });
  }
  if (heads.length >= 2) {
    for (let i = 0; i < heads.length; i++) {
      const end = i + 1 < heads.length ? heads[i + 1].index - heads[i].index - (heads[i + 1].index - heads[i + 1].name.length) : undefined;
      const body = i + 1 < heads.length ? src.slice(heads[i].index, heads[i + 1].index) : src.slice(heads[i].index);
      cards.push(sectionToCard(heads[i].name, body));
    }
    return cards.filter((c) => c.name !== '未命名角色');
  }

  // 没有标题：按 "姓名：xxx" 标签行切块
  const nameRe = /(?:^|\n)\s*(?:\*\*)?姓名[：:]\s*([^\n]+)/g;
  const nameBlocks = [];
  let nm;
  while ((nm = nameRe.exec(src)) !== null) {
    nameBlocks.push({ name: nm[1], start: nm.index + nm[0].length - nm[1].length });
  }
  if (nameBlocks.length >= 2) {
    for (let i = 0; i < nameBlocks.length; i++) {
      const body = src.slice(nameBlocks[i].start, i + 1 < nameBlocks.length ? nameBlocks[i + 1].start : src.length);
      cards.push(sectionToCard(nameBlocks[i].name, body));
    }
    return cards.filter((c) => c.name !== '未命名角色');
  }
  return [];
}

/* ---------------- 单卡备份格式（.moibi.character.json） ---------------- */

export function buildCharacterBackup(card) {
  return JSON.stringify({
    app: 'moibi',
    type: 'character-card',
    version: 1,
    exportedAt: new Date().toISOString(),
    character: {
      name: card.name, aliases: card.aliases || [], role: card.role,
      gender: card.gender || '', age: card.age || '',
      identity: card.identity || '', appearance: card.appearance || '',
      personality: card.personality || '', motivation: card.motivation || '',
      arc: card.arc || '', relationships: card.relationships || [],
      abilities: card.abilities || [], status: card.status || 'alive',
      statusNote: card.statusNote || '', highlight: card.highlight || '',
    },
  }, null, 2);
}

export function parseCharacterBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (data?.app !== 'moibi' || data?.type !== 'character-card' || !data?.character?.name) {
    throw new Error('这不是墨笔的角色卡文件');
  }
  const c = data.character;
  const str = (v, max) => String(v || '').slice(0, max ?? 10000);
  return {
    name: str(c.name, 60) || '未命名角色',
    aliases: Array.isArray(c.aliases) ? c.aliases.map((a) => str(a, 40)).filter(Boolean) : [],
    role: ['主角', '配角', '反派'].includes(c.role) ? c.role : '配角',
    gender: str(c.gender, 20), age: str(c.age, 20),
    identity: str(c.identity), appearance: str(c.appearance),
    personality: str(c.personality), motivation: str(c.motivation), arc: str(c.arc),
    relationships: Array.isArray(c.relationships)
      ? c.relationships.map((r) => ({ name: str(r?.name, 60), relation: str(r?.relation, 40), note: str(r?.note, 200) })).filter((r) => r.name)
      : [],
    abilities: Array.isArray(c.abilities) ? c.abilities.map((a) => str(a, 100)).filter(Boolean) : [],
    status: ['alive', 'dead', 'missing', 'changed'].includes(c.status) ? c.status : 'alive',
    statusNote: str(c.statusNote, 500), highlight: str(c.highlight, 200),
  };
}

export { uid };
