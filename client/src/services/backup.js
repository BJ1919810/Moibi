/** 项目 JSON 备份：导出（下载/分享）与解析恢复 */

/**
 * 生成项目备份文本（含完整工程：大纲/人设/伏笔/设定簿/章节/随笔/讨论）。
 * @param {Object} project
 * @returns {string}
 */
export function buildBackup(project) {
  return JSON.stringify({
    app: 'moibi',
    type: 'project-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: {
      name: project.name,
      category: project.category,
      coreIdea: project.coreIdea,
      outline: project.outline,
      characters: project.characters,
      foreshadowing: project.foreshadowing,
      memory: project.memory,
      chapters: (project.chapters || []).map((c) => ({
        title: c.title || '',
        content: c.content || '',
        notes: c.notes || '',
      })),
      discussions: project.discussions || [],
    },
  }, null, 2);
}

/**
 * 解析并校验备份文本。
 * @param {string} text
 * @returns {{ name, category, coreIdea, outline, characters, foreshadowing, memory, chapters, discussions }}
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  // 兼容早期版本导出的 "mobin" 标记备份
  if ((data?.app !== 'moibi' && data?.app !== 'mobin') || data?.type !== 'project-backup' || !data?.project?.name) {
    throw new Error('这不是墨笔的项目备份文件');
  }
  const p = data.project;
  const str = (v, max) => String(v || '').slice(0, max ?? 100000);
  return {
    name: str(p.name, 60) || '未命名作品',
    category: str(p.category, 40) || '未分类',
    coreIdea: str(p.coreIdea, 300),
    outline: str(p.outline),
    characters: str(p.characters),
    foreshadowing: str(p.foreshadowing),
    memory: str(p.memory),
    chapters: Array.isArray(p.chapters)
      ? p.chapters.map((c) => ({
          title: str(c.title, 120),
          content: str(c.content),
          notes: str(c.notes),
        }))
      : [],
    discussions: Array.isArray(p.discussions) ? p.discussions : [],
  };
}

/**
 * 导出备份：原生 App 走系统分享/保存，网页端直接下载 .mobin.json 文件。
 * @param {Object} project
 * @returns {Promise<string>} 提示文案
 */
export async function exportBackup(project) {
  const text = buildBackup(project);
  const fileName = `${project.name}.moibi.json`;

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const result = await Filesystem.writeFile({
        path: fileName,
        data: text,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({
        title: '备份项目',
        text: `${project.name} - 墨笔备份`,
        url: result.uri,
        dialogTitle: '保存备份到…',
      });
      return '已导出备份 ✓';
    }
  } catch (e) {
    if (/cancel{1,2}ed/i.test(e?.message || '')) return '已取消';
  }

  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
  return '已下载备份 ✓';
}
