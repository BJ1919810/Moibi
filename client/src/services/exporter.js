export function buildTxt(p) {
  const lines = [`《${p.name}》`, ''];
  p.chapters.forEach((c, i) => {
    // 防御性清理：章节名里残留的"第X章 "前缀不重复出现在导出文件里
    const title = String(c.title || '').replace(/^(?:#+\s*)?第.+?章\s*/, '').trim() || c.title || '';
    lines.push(`第${i + 1}章  ${title}`, '', c.content, '');
  });
  return lines.join('\n');
}

export async function exportProject(p) {
  if (!p.chapters?.length) return '暂无正文可导出';
  const txt = buildTxt(p);
  const fileName = `${p.name}.txt`;

  // 原生 App（Android）路径：写入缓存后走系统分享/保存
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');

      // 写入缓存目录
      const result = await Filesystem.writeFile({
        path: fileName,
        data: txt,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });

      // 分享文件（弹出系统文件管理器/分享菜单让用户选择保存位置）
      await Share.share({
        title: '导出小说',
        text: `${p.name} - 墨笔导出`,
        url: result.uri,
        dialogTitle: '保存到…',
      });

      return '已导出 ✓';
    }
  } catch (e) {
    // 用户取消分享时不再下载；其他错误（如原生 API 不可用）则回退到浏览器下载
    if (/cancel{1,2}ed/i.test(e?.message || '')) {
      return '已取消';
    }
  }

  // 网页端 / 回退路径：直接触发浏览器下载为 .txt 文件
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
  return '已下载 TXT ✓';
}
