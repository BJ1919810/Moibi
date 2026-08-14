import { store } from '../services/store.js';
import * as ai from '../services/deepseek.js';
import { parseTxt } from '../services/parser.js';
import { parseBackup, exportBackup } from '../services/backup.js';

const MAX_IMPORT_SIZE = 2 * 1024 * 1024; // 导入上限 2MB

/**
 * 字节解码：识别 UTF-8 BOM / UTF-16 LE·BE BOM，其余按 UTF-8 解码，
 * 替换符占比过高时回退 GBK（兼容旧 TXT）。
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
export function decodeTxt(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(b.subarray(2));
  }
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(b.subarray(2));
  }
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(b.subarray(3));
  }
  const utf8 = new TextDecoder('utf-8').decode(b);
  const fffd = (utf8.match(/\uFFFD/g) || []).length;
  if (fffd > 0 && fffd / Math.max(1, utf8.length) > 0.02) {
    try {
      return new TextDecoder('gbk').decode(b);
    } catch { /* 保持 UTF-8 结果 */ }
  }
  return utf8;
}

export const api = {
  async listProjects(category) { return store.listProjects(category); },
  async listCategories() { return store.listCategories(); },
  async createProject(body) { return store.createProject(body); },
  async getProject(id) { return store.getProject(id); },
  async updateProject(id, body) { return store.updateProject(id, body); },
  async deleteProject(id) { return store.deleteProject(id); },
  async addChapter(id, body) { return store.addChapter(id, body); },
  async updateChapter(id, cid, body) { return store.updateChapter(id, cid, body); },
  async deleteChapter(id, cid) { return store.deleteChapter(id, cid); },

  /** 读取并解析 TXT（不落库），供导入预览与正式导入共用 */
  async readTxtFile(file) {
    if (file.size > MAX_IMPORT_SIZE) {
      throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），超过 2MB 限制`);
    }
    const buf = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
    const raw = decodeTxt(buf);
    const { project: info, chapters } = parseTxt(raw, file.name);
    return { info, chapters };
  },

  /** 导入预览：只解析不创建项目 */
  async previewTxt(file) {
    return this.readTxtFile(file);
  },

  /** 导入 TXT 文件：解析 → 创建项目 → 批量写入章节 */
  async importTxt(file) {
    const { info, chapters } = await this.readTxtFile(file);
    const project = store.createProject(info);
    if (chapters.length > 0) store.bulkAddChapters(project.id, chapters);
    return store.getProject(project.id);
  },

  /** 导出项目 JSON 备份（下载 / 系统分享） */
  async backupProject(project) {
    return exportBackup(project);
  },

  /** 从备份 JSON 恢复：创建新项目并写回全部工程数据 */
  async importBackupFile(file) {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('备份文件过大（超过 10MB）');
    }
    const buf = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
    const data = parseBackup(decodeTxt(buf));
    const created = store.createProject({
      name: data.name,
      category: data.category,
      coreIdea: data.coreIdea,
    });
    store.updateProject(created.id, {
      outline: data.outline,
      characters: data.characters,
      foreshadowing: data.foreshadowing,
      memory: data.memory,
    });
    if (data.chapters.length > 0) store.bulkAddChapters(created.id, data.chapters);
    if (data.discussions.length > 0) store.updateProject(created.id, { discussions: data.discussions });
    return store.getProject(created.id);
  },

  aiOutline: ai.outline,
  aiCharacters: ai.characters,
  aiForeshadowing: ai.foreshadowing,
  aiChapter: ai.chapter,
  aiChapterUpdateOnly: ai.chapterUpdateOnly,
  aiPostProcess: ai.postProcessChapter,
  aiDiscuss: ai.discuss,
  aiTidyMemory: ai.tidyMemory,
  aiExtractMemory: ai.extractMemory,
};
