import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../utils/api.js';
import { exportProject } from '../services/exporter.js';
import { parseChapterOutput, mergeMemory, hasMetaOpening, hasGarbledDoc, dedupeLeadingLines } from '../services/parser.js';
import { setAiBusy, clearAiBusy } from '../services/aiBusy.js';
import { abortActiveRequest, getHqMode } from '../services/deepseek.js';
import { parsePatches, toolCallsToPatches } from '../services/discussPatches.js';
import { saveDraft, loadDraft, clearDraft } from '../services/drafts.js';
import { renderCardsToText } from '../services/characterCards.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import CharactersPanel from '../components/CharactersPanel.jsx';
import { GENRES_SECTIONS } from './HomePage.jsx';

// 章节全屏编辑标志（供 App.jsx 返回键判断：全屏时退出全屏而非退出项目）
let _chapterFullscreen = false;
export const isChapterFullscreen = () => _chapterFullscreen;

const TABS = [
  { key: 'info', label: '作品信息', icon: '📋' },
  { key: 'characters', label: '角色设定', icon: '🎭' },
  { key: 'foreshadowing', label: '伏笔设计', icon: '🪢' },
  { key: 'outline', label: '剧情大纲', icon: '🗺️' },
  { key: 'chapters', label: '章节续写', icon: '📖' },
  { key: 'memory', label: '设定簿', icon: '🗂️' },
  { key: 'discuss', label: '创作讨论', icon: '💬' },
];

export default function ProjectPage({ projectId, onBack }) {
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('characters');
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [exporting, setExporting] = useState(false);
  const [memoryConfirm, setMemoryConfirm] = useState(false);
  const memoryConfirmRef = useRef(null);

  useEffect(() => {
    setLoadError('');
    setProject(null);
    api.getProject(projectId)
      .then(setProject)
      .catch((e) => setLoadError(e.message || '项目加载失败'));
  }, [projectId]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  const patch = async (body) => {
    const updated = await api.updateProject(projectId, body);
    setProject(updated);
    return updated;
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      flash(await exportProject(project));
    } catch (e) {
      flash('导出失败：' + e.message);
    } finally {
      setExporting(false);
    }
  };

  const activeLabel = TABS.find((t) => t.key === tab)?.label || '';

  // 移动端边缘右滑唤出菜单
  const touchStart = useRef(null);
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  };
  const handleTouchMove = (e) => {
    if (!touchStart.current) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    // 如果正在从左边缘右滑，阻止默认滚动避免冲突
    if (touchStart.current.x < 55 && dx > 20 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
    }
  };
  const handleTouchEnd = (e) => {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    const dt = Date.now() - touchStart.current.time;
    const fromLeftEdge = touchStart.current.x < 55;
    const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;

    if (fromLeftEdge && dx > 70 && isHorizontal && dt < 400) {
      setMenuOpen(true);
    }
    // 菜单打开时左滑关闭
    if (menuOpen && dx < -70 && isHorizontal && dt < 400) {
      setMenuOpen(false);
    }
    touchStart.current = null;
  };

  if (loadError) {
    return (
      <div className="loading-screen">
        <span className="loading-glyph">墨</span>
        <p>展卷失败：{loadError}</p>
        <button className="btn btn--primary" style={{ marginTop: 18 }} onClick={onBack}>
          ← 返回书案
        </button>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="loading-screen">
        <span className="loading-glyph">墨</span>
        <p>展 卷 中 …</p>
      </div>
    );
  }

  return (
    <div
      className="workspace"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <aside className="side">
        <button className="side__back" onClick={onBack}>← 返回书案</button>
        <div className="side__info">
          <span className="side__cat">{project.category}</span>
          <h2 className="side__name">《{project.name}》</h2>
          <p className="side__idea">{project.coreIdea}</p>
        </div>
        <nav className="side__tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`side-tab ${tab === t.key ? 'side-tab--active' : ''}`}
              onClick={() => {
                setTab(t.key);
                setMenuOpen(false);
              }}
            >
              <span>{t.icon}</span> {t.label}
              {t.key === 'chapters' && project.chapters.length > 0 && (
                <i className="side-tab__badge">{project.chapters.length}</i>
              )}
            </button>
          ))}
        </nav>
        <button className="btn btn--gold side__export" onClick={handleExport} disabled={exporting}>
          {exporting ? '装订中…' : '⬇ 一键导出 TXT'}
        </button>
      </aside>

      {/* 移动端抽屉遮罩与菜单 */}
      <div
        className={`mobile-menu-mask ${menuOpen ? 'mobile-menu-mask--open' : ''}`}
        onClick={() => setMenuOpen(false)}
      />
      <aside className={`mobile-menu ${menuOpen ? 'mobile-menu--open' : ''}`}>
        <div className="mobile-menu__head">
          <span className="mobile-menu__cat">{project.category}</span>
          <h2 className="mobile-menu__name">《{project.name}》</h2>
          <p className="mobile-menu__idea">{project.coreIdea}</p>
        </div>
        <nav className="mobile-menu__tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`mobile-menu-tab ${tab === t.key ? 'mobile-menu-tab--active' : ''}`}
              onClick={() => {
                setTab(t.key);
                setMenuOpen(false);
              }}
            >
              <span>{t.icon}</span> {t.label}
              {t.key === 'chapters' && project.chapters.length > 0 && (
                <i className="mobile-menu-tab__badge">{project.chapters.length}</i>
              )}
            </button>
          ))}
        </nav>
        <button className="btn btn--gold mobile-menu__export" onClick={handleExport} disabled={exporting}>
          {exporting ? '装订中…' : '⬇ 一键导出 TXT'}
        </button>
        <button className="mobile-menu__back" onClick={onBack}>← 返回书案</button>
      </aside>

      <button className="mobile-menu-fab" onClick={() => setMenuOpen(true)} title="菜单">
        ☰
      </button>

      <section className="stage">
        <InfoPanel hidden={tab !== 'info'} project={project} onSave={patch} flash={flash} />
        <CharactersPanel hidden={tab !== 'characters'} project={project} onChanged={setProject} flash={flash} />
        <DocPanel
          hidden={tab !== 'foreshadowing'}
          title="伏笔设计"
          hint="AI 将根据角色设定设计互相勾连的伏笔网络"
          value={project.foreshadowing}
          busyText="正在编织伏笔…"
          onSave={(v) => patch({ foreshadowing: v }).then(() => flash('伏笔已保存 ✓'))}
          onGenerate={() =>
            api.aiForeshadowing({
              name: project.name, category: project.category,
              coreIdea: project.coreIdea,
              outline: project.outline,
              characters: project.characters,
              memory: project.memory,
            })
          }
        />
        <DocPanel
          hidden={tab !== 'outline'}
          title="剧情大纲"
          hint="AI 将推演多个差异化剧情方案，供你挑选主线"
          value={project.outline}
          busyText="正在推演剧情…"
          variantsMode
          onSave={(v) => patch({ outline: v }).then(() => flash('大纲已保存 ✓'))}
          onGenerate={(direction) => api.aiOutline({ name: project.name, category: project.category, coreIdea: project.coreIdea, outline: project.outline, characters: project.characters, foreshadowing: project.foreshadowing, memory: project.memory, direction })}
          onVariants={() => api.aiOutlineVariants({ name: project.name, category: project.category, coreIdea: project.coreIdea, outline: project.outline, characters: project.characters, foreshadowing: project.foreshadowing, memory: project.memory })}
        />
        <ChaptersPanel hidden={tab !== 'chapters'} project={project} onChanged={setProject} flash={flash} />
        <DocPanel
          hidden={tab !== 'memory'}
          title="设定簿"
          hint="当下情报（物品 / 关系 / 地点 / 未了结线索等当前状态，随剧情更新；能力归角色卡）。续写时 AI 会把本章新变化自动同步进来；也可“从正文抽取”重建，或点“AI 整理”压缩"
          value={project.memory}
          busyText="正在整理设定簿…"
          extractBusyText="正在从正文抽取设定…"
          generateLabel="AI 整理"
          onSave={(v) => patch({ memory: v }).then(() => flash('设定簿已保存 ✓'))}
          onGenerate={() => api.aiTidyMemory({ name: project.name, memory: project.memory, hasCards: (project.characterCards || []).length > 0 })}
          onExtract={() => {
            const chapters = project.chapters
              .map((c, i) => ({ index: i + 1, title: c.title, content: c.content }))
              .filter((c) => c.content && c.content.trim());
            if (chapters.length === 0) {
              flash('暂无正文可抽取');
              return null;
            }
            if (!project.memory) {
              return api.aiExtractMemory({ name: project.name, chapters }).then((r) => r.content);
            }
            // 已有设定簿：弹确认框，确认后再执行抽取
            return new Promise((resolve) => {
              memoryConfirmRef.current = { chapters, resolve };
              setMemoryConfirm(true);
            });
          }}
        />
        <DiscussPanel
          hidden={tab !== 'discuss'}
          project={project}
          onPersist={(discussions) => patch({ discussions })}
          onPatch={setProject}
        />
      </section>

      {toast && <div className="toast">{toast}</div>}

      <ConfirmDialog
        open={memoryConfirm}
        title="覆盖设定簿"
        message="将根据全部章节重新抽取设定并覆盖当前设定簿，继续？"
        danger
        confirmText="覆盖并抽取"
        onCancel={() => {
          memoryConfirmRef.current?.resolve(null);
          memoryConfirmRef.current = null;
          setMemoryConfirm(false);
        }}
        onConfirm={() => {
          const job = memoryConfirmRef.current;
          memoryConfirmRef.current = null;
          setMemoryConfirm(false);
          job?.resolve(
            api.aiExtractMemory({ name: project.name, chapters: job.chapters }).then((r) => r.content)
          );
        }}
      />
    </div>
  );
}

/* ---------- 作品信息面板 ---------- */
function InfoPanel({ hidden, project, onSave, flash }) {
  const [form, setForm] = useState({
    name: project.name,
    coreIdea: project.coreIdea,
  });
  const initialGenres = (project.category && project.category !== '未分类')
    ? project.category.split('/').filter(Boolean)
    : [];
  const [selectedGenres, setSelectedGenres] = useState(initialGenres);
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggleGenre = (g) => {
    setSelectedGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  };
  const categoryStr = selectedGenres.length ? selectedGenres.join('/') : '未分类';

  const changed =
    form.name !== project.name ||
    categoryStr !== (project.category || '未分类') ||
    form.coreIdea !== project.coreIdea;

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return flash('作品名称不能为空');
    if (!form.coreIdea.trim()) return flash('核心想法不能为空');
    setBusy(true);
    try {
      await onSave({
        name: form.name.trim(),
        category: categoryStr,
        coreIdea: form.coreIdea.trim(),
      });
      flash('作品信息已保存 ✓');
    } catch (e) {
      flash('保存失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ display: hidden ? 'none' : 'flex' }}>
      <header className="panel__head">
        <div>
          <h2 className="panel__title">作品信息</h2>
          <p className="panel__hint">修改书名、分类与一句话灵感</p>
        </div>
      </header>

      <form className="info-form" onSubmit={submit}>
        <label className="info-field">
          <span>作品名称</span>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：长夜提灯人"
            disabled={busy}
          />
        </label>

        <div className="info-field">
          <span>分类（可多选）</span>
          <button
            type="button"
            className={`genre-display ${selectedGenres.length ? 'genre-display--filled' : ''}`}
            onClick={() => setShowPicker((v) => !v)}
            disabled={busy}
          >
            {selectedGenres.length ? selectedGenres.join(' / ') : '点击选择分类'}
          </button>
          {showPicker && (
            <div className="genre-grid">
              {GENRES_SECTIONS.map((sec) => (
                <div key={sec.title} className="genre-sec">
                  <span className="genre-sec__label">{sec.title}</span>
                  <div className="genre-sec__tags">
                    {sec.tags.map((g) => (
                      <button
                        type="button"
                        key={g}
                        className={`genre-btn ${selectedGenres.includes(g) ? 'genre-btn--active' : ''}`}
                        onClick={() => toggleGenre(g)}
                        disabled={busy}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="info-field">
          <span>核心想法（一句话灵感）</span>
          <textarea
            rows={6}
            value={form.coreIdea}
            onChange={(e) => setForm({ ...form, coreIdea: e.target.value })}
            placeholder="例如：一个只能看见别人死亡倒计时的少年，发现自己头顶的数字是负数。"
            disabled={busy}
          />
        </label>

        <div className="info-form__actions">
          <button type="submit" className="btn btn--primary" disabled={!changed || busy}>
            {busy ? '保存中…' : '💾 保存修改'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- 通用文档面板（大纲 / 人设 / 伏笔 / 设定簿） ---------- */
function DocPanel({ hidden, title, hint, value, busyText, onSave, onGenerate, generateLabel, onExtract, extractLabel, extractBusyText, variantsMode, onVariants }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [variants, setVariants] = useState(null); // 大纲走向列表
  const [selectedIdx, setSelectedIdx] = useState(-1); // 当前选中的走向下标
  const dirty = text !== value;

  // 外部更新（续写后设定簿追加、讨论应用修改等）时同步显示，避免停留旧内容
  useEffect(() => {
    setText(value || '');
  }, [value]);

  /** 采纳一段生成内容：去重开头、写入编辑区、自动保存 */
  const adopt = async (content) => {
    const out = dedupeLeadingLines(String(content || '').trim()); // 折叠 prefill 与模型重复输出的开头标题
    setText(out);
    if (hasGarbledDoc(out)) {
      setError('⚠️ 生成结果疑似异常（混入了整理/修正类文字），已保留在编辑区供手动修改，建议再次生成');
    } else {
      await onSave(out);
    }
  };

  const generate = async () => {
    if (!onGenerate && !onVariants) return;
    setBusy(true);
    setError('');
    setAiBusy(variantsMode ? '正在推演多个剧情方案…' : busyText, abortActiveRequest);
    try {
      if (variantsMode && onVariants) {
        // 多方案模式：先出方案列表，等用户挑选后再落库
        const { variants: list } = await onVariants();
        if (!Array.isArray(list) || list.length < 2) throw new Error('AI 返回的方案不足，请重试');
        setVariants(list);
        setSelectedIdx(-1);
        return; // 等待用户选择走向
      }
      let { content } = await onGenerate();
      if (hasGarbledDoc(content)) {
        // 输出混入"修正/整理/归档"等异常文字：重新生成一次
        setAiBusy('检测到输出异常，正在重新生成…', abortActiveRequest);
        ({ content } = await onGenerate());
      }
      await adopt(content);
    } catch (e) {
      if (e.message !== '已取消') setError(e.message);
    } finally {
      setBusy(false);
      clearAiBusy();
    }
  };

  /** 第二阶段：把选中的走向展开为详尽大纲 */
  const expandVariant = async () => {
    const v = variants && selectedIdx >= 0 ? variants[selectedIdx] : null;
    if (!v) return;
    setBusy(true);
    setError('');
    setAiBusy('正在展开所选方案…', abortActiveRequest);
    try {
      const direction = [v.name, v.pivot, v.pitch].filter(Boolean).join('\n');
      let { content } = await onGenerate(direction);
      if (hasGarbledDoc(content)) {
        // 输出混入"修正/整理/归档"等异常文字：重新生成一次
        setAiBusy('检测到输出异常，正在重新生成…', abortActiveRequest);
        ({ content } = await onGenerate(direction));
      }
      setVariants(null);
      await adopt(content);
    } catch (e) {
      if (e.message !== '已取消') setError(e.message);
    } finally {
      setBusy(false);
      clearAiBusy();
    }
  };

  const extract = async () => {
    if (!onExtract) return;
    setBusy(true);
    setError('');
    setAiBusy(extractBusyText || '正在抽取…', abortActiveRequest);
    try {
      const content = await onExtract();
      if (!content) return; // 用户取消或无内容
      setText(content);
      await onSave(content);
    } catch (e) {
      if (e.message !== '已取消') setError(e.message);
    } finally {
      setBusy(false);
      clearAiBusy();
    }
  };

  return (
    <div className="panel" style={{ display: hidden ? 'none' : 'flex' }}>
      <header className="panel__head">
        <div>
          <h2 className="panel__title">{title}</h2>
          <p className="panel__hint">{hint}</p>
        </div>
        <div className="panel__actions">
          {onExtract && (
            <button className="btn btn--ghost" onClick={extract} disabled={busy}>
              📚 {extractLabel || '从正文抽取'}
            </button>
          )}
          {onGenerate && (
            <button className="btn btn--primary" onClick={generate} disabled={busy}>
              {busy ? <span className="spinner" /> : '✨'} {busy ? busyText : generateLabel || (value ? '重新生成' : 'AI 生成')}
            </button>
          )}
          <button className="btn btn--ghost" onClick={() => onSave(text)} disabled={!dirty || busy}>
            💾 保存
          </button>
        </div>
      </header>

      {error && <p className="panel__error">⚠️ {error}</p>}
      {busy && (
        <div className="typing-bar">
          <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
          {busyText}
        </div>
      )}

      <div className="editor-wrap">
        <button className="preview-fab" onClick={() => setPreview(!preview)} title={preview ? '编辑' : '预览'}>
          {preview ? '✏️' : '👁️'}
        </button>
        {preview ? (
          <div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        ) : (
          <textarea
            className="doc-editor"
            placeholder="点击「AI 生成」，或在此直接书写…"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </div>

      {variants && (
        <div className="modal-mask" style={{ zIndex: 200 }} onClick={() => setVariants(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">选择剧情走向</h2>
            <p className="modal__hint">AI 给出了 {variants.length} 个简练走向（约 100 字），点击切换查看，选定后生成详尽大纲。</p>
            <div className="variant-grid">
              {variants.map((v, i) => (
                <button
                  key={i}
                  type="button"
                  className={`variant-card ${selectedIdx === i ? 'variant-card--selected' : ''}`}
                  onClick={() => setSelectedIdx(i)}
                >
                  <span className="variant-card__name">{v.name || `方案 ${i + 1}`}</span>
                  {v.pivot && <span className="variant-card__pivot">{v.pivot}</span>}
                  {v.pitch && <span className="variant-card__pitch">{v.pitch}</span>}
                </button>
              ))}
            </div>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setVariants(null)}>关闭</button>
              <button type="button" className="btn btn--ghost" onClick={() => { setVariants(null); generate(); }} disabled={busy}>🔁 重新生成</button>
              <button type="button" className="btn btn--primary" onClick={expandVariant} disabled={selectedIdx < 0 || busy}>
                {busy ? '展开中…' : '✨ 生成详细大纲'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 简单 Markdown 渲染（按行解析：标题、列表、引用、表格，不引入外部依赖） */
function renderMarkdown(md) {
  if (!md) return '<p class="md-empty">暂无内容</p>';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 行内样式：先转义，再替换 code/strong/em（code 先做，避免内部被强调符二次处理）
  const inline = (s) => esc(s)
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

  const isTableLine = (l) => /^\s*\|.*\|/.test(l);
  const isSepRow = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
  const parseRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listOpen = false, quoteOpen = false, para = [];
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  const closeQuote = () => { if (quoteOpen) { out.push('</blockquote>'); quoteOpen = false; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 表格：以 | 开头的连续行，第二行为分隔行时渲染为 <table>
    if (isTableLine(line) && isSepRow(lines[i + 1] || '')) {
      flushPara(); closeList(); closeQuote();
      const rows = [line];
      let j = i + 1;
      while (j < lines.length && isTableLine(lines[j])) { rows.push(lines[j]); j++; }
      const head = parseRow(rows[0]);
      const bodyRows = rows.slice(2).filter((r) => !isSepRow(r)).map(parseRow);
      const cell = (arr, tag) => arr.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('');
      let html = '<div class="md-table-wrap"><table><thead><tr>' + cell(head, 'th') + '</tr></thead>';
      if (bodyRows.length) {
        html += '<tbody>' + bodyRows.map((r) => `<tr>${cell(r, 'td')}</tr>`).join('') + '</tbody>';
      }
      out.push(html + '</table></div>');
      i = j - 1;
      continue;
    }

    if (/^---+\s*$/.test(line)) { flushPara(); closeList(); closeQuote(); out.push('<hr>'); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); closeList(); closeQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = /^[-*]\s+(.*)$/.exec(line) || /^\d+\.\s+(.*)$/.exec(line);
    if (li) { flushPara(); closeQuote(); if (!listOpen) { out.push('<ul>'); listOpen = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) { flushPara(); closeList(); if (!quoteOpen) { out.push('<blockquote>'); quoteOpen = true; } out.push(`<p>${inline(bq[1])}</p>`); continue; }
    if (line.trim() === '') { flushPara(); closeList(); closeQuote(); }
    else para.push(inline(line));
  }
  flushPara(); closeList(); closeQuote();
  return out.join('\n');
}

/* ---------- 章节面板 ---------- */
function ChaptersPanel({ hidden, project, onChanged, flash }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [showHint, setShowHint] = useState(false);
  const [hint, setHint] = useState('');
  const [draft, setDraft] = useState(null);
  const [hqLog, setHqLog] = useState(null); // 高质量模式的决策过程（规划/批改）

  // 检查是否有上次中断/停止留下的续写草稿
  useEffect(() => {
    setDraft(loadDraft(project.id));
  }, [project.id]);

  // 弹窗支持 Esc 关闭
  useEffect(() => {
    if (!showHint) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowHint(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHint]);

  const continueWriting = async (hint = '') => {
    setBusy(true);
    setError('');
    setHqLog(null);
    const chapterIndex = project.chapters.length + 1;
    const hq = getHqMode();
    const draftCall = hq ? api.aiChapterHQ : api.aiChapter;
    setAiBusy(hq ? `正在规划并续写第 ${chapterIndex} 章…` : `正在续写第 ${chapterIndex} 章…`, abortActiveRequest);
    // 断点保护：把 AI 已输出的部分定期写入草稿，中断后可找回
    let draftText = `第${chapterIndex}章 `;
    const draftTimer = setInterval(() => {
      if (draftText.trim()) {
        saveDraft(project.id, { chapterIndex, hint, text: draftText, updatedAt: Date.now() });
      }
    }, 2000);
    try {
      const last = project.chapters[project.chapters.length - 1];
      const base = {
        name: project.name, category: project.category,
        coreIdea: project.coreIdea,
        outline: project.outline,
        characters: project.characters,
        foreshadowing: project.foreshadowing,
        memory: project.memory || '',
        prevChapter: last ? { title: last.title, content: last.content } : null,
        chapterIndex,
        notes: last?.notes || '',
        hint,
        onChunk: (delta) => { draftText += delta; },
        onPhase: hq ? (info) => setHqLog((prev) => ({ ...(prev || {}), ...info })) : undefined,
      };
      let { content, stateUpdate } = await draftCall(base);
      let parsed = parseChapterOutput(content);
      if (hasMetaOpening(parsed.cleanContent)) {
        // 开头出现元话术：带纠错提示重新生成一次
        setAiBusy('开头异常，正在重新续写…', abortActiveRequest);
        draftText = `第${chapterIndex}章 `;
        ({ content, stateUpdate } = await draftCall({
          ...base,
          correction: '上一条回复开头出现了与小说无关的内容。请重新生成本章：第一行直接输出"第X章 标题"，随后立即进入正文。',
        }));
        parsed = parseChapterOutput(content);
      }
      const { cleanContent, notes: newNotes } = parsed;

      // 标题容错：若第一行不是"第X章"（可能被元话术顶到前面），在开头几行内找标题，丢弃其前的废话
      const lines = cleanContent.split('\n');
      let titleIdx = 0;
      for (let i = 0; i < Math.min(lines.length, 4); i++) {
        if (/^第.+?章/.test(lines[i].trim())) { titleIdx = i; break; }
      }
      const [firstLine, ...rest] = lines.slice(titleIdx);
      let bodyText = rest.join('\n').trim() || cleanContent;
      // 去掉正文开头重复出现的标题行（模型偶尔会在正文里再写一次"## 第X章 标题"）
      bodyText = bodyText.replace(/^(?:\s*#+\s*)?第.+?章[^\n]*\n?/, '').trim();
      const chapter = await api.addChapter(project.id, {
        // 连续去掉所有"# "与"第X章 "前缀（模型偶尔会重复输出"第1章 第1章 标题"）
        title: firstLine.replace(/^(?:#+\s*)?(?:第.+?章\s*)+/, '').trim() || `第${chapterIndex}章`,
        content: bodyText,
        notes: newNotes,
      });

      let updated = await api.getProject(project.id);
      let memorySynced = false;
      let updateText = stateUpdate;
      if (!updateText && chapter.content.trim()) {
        // 模型漏掉【设定更新】块：根据正文补抽一次，避免设定簿断更
        setAiBusy('正在补全设定更新…', abortActiveRequest);
        try {
          const fallback = await api.aiChapterUpdateOnly({
            name: project.name,
            content: chapter.content,
            memory: project.memory,
          });
          updateText = fallback.content;
        } catch { /* 补抽失败则不更新设定簿 */ }
      }
      if (updateText) {
        const memory = mergeMemory(project.memory || '', updateText, chapterIndex);
        if (memory !== (project.memory || '')) {
          updated = await api.updateProject(project.id, { memory });
          memorySynced = true;
        }
      }
      // 角色卡同步（best-effort：失败不影响章节保存；仅在有角色卡的项目上执行）
      if (updateText && (project.characterCards || []).length > 0) {
        try {
          const synced = await api.aiSyncCards({
            name: project.name,
            cards: project.characterCards,
            stateUpdate: updateText,
          });
          if (synced?.cards && JSON.stringify(synced.cards) !== JSON.stringify(project.characterCards)) {
            updated = await api.updateProject(project.id, {
              characterCards: synced.cards,
              characters: renderCardsToText(synced.cards),
            });
          }
        } catch { /* 同步失败保持原卡片 */ }
      }
      onChanged(updated);
      setEditing(chapter.id);
      clearDraft(project.id);
      setDraft(null);
      flash(memorySynced ? '新章节已生成，设定簿已同步 ✓' : '新章节已生成 ✓');
    } catch (e) {
      if (e.message === '已取消') flash('已停止生成');
      else setError(e.message);
      // 中断/失败：保留已输出部分为草稿，下次可保存为章节
      if (draftText.trim()) {
        const d = { chapterIndex, hint, text: draftText, updatedAt: Date.now() };
        saveDraft(project.id, d);
        setDraft(d);
      }
    } finally {
      clearInterval(draftTimer);
      setBusy(false);
      clearAiBusy();
    }
  };

  const saveDraftAsChapter = async () => {
    if (!draft) return;
    try {
      const lines = draft.text.split('\n');
      const firstLine = (lines.find((l) => l.trim()) || '').trim();
      const title = firstLine.replace(/^(?:#+\s*)?(?:第.+?章\s*)+/, '').trim() || `第${draft.chapterIndex}章（草稿）`;
      const body = lines.slice(firstLine ? lines.indexOf(firstLine) + 1 : 0).join('\n').trim();
      const chapter = await api.addChapter(project.id, { title, content: body, notes: '' });
      clearDraft(project.id);
      setDraft(null);
      onChanged(await api.getProject(project.id));
      setEditing(chapter.id);
      flash('已保存为章节，可继续编辑 ✓');
    } catch (e) {
      setError(e.message);
    }
  };

  const discardDraft = () => {
    clearDraft(project.id);
    setDraft(null);
    flash('草稿已丢弃');
  };

  const addBlankChapter = async () => {
    try {
      const chapter = await api.addChapter(project.id, {
        title: `第${project.chapters.length + 1}章`,
        content: '',
      });
      onChanged(await api.getProject(project.id));
      setEditing(chapter.id);
      flash('已新增空章节，开始写作吧 ✍️');
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="panel" style={{ display: hidden ? 'none' : 'flex' }}>
      <header className="panel__head">
        <div>
          <h2 className="panel__title">章节续写</h2>
          <p className="panel__hint">基于大纲、设定簿与上一章结尾自动续写；AI 会自动把新能力/物品/关系同步进设定簿</p>
        </div>
        <div className="panel__head-ops">
          <button className="btn btn--ghost btn--sm" onClick={addBlankChapter} title="手动新增空章节">➕ 手动新增</button>
          <button className="btn btn--primary" onClick={() => {
            if (project.chapters.length === 0) setShowHint(true);
            else continueWriting();
          }} disabled={busy}>
            {busy ? <span className="spinner" /> : '🖋️'} {busy ? '正在续写…' : project.chapters.length === 0 ? '开辟新章' : `续写第 ${project.chapters.length + 1} 章`}
          </button>
        </div>
      </header>

      {hqLog && (
        <div className="hq-log">
          <div className="hq-log__head">
            <span>🛡️ AI 决策过程</span>
            {busy && <span className="hq-log__live">进行中…</span>}
            <button type="button" className="hq-log__close" title="收起" onClick={() => setHqLog(null)}>✕</button>
          </div>
          {hqLog.plan && (
            <div className="hq-log__block">
              <span className="hq-log__stage">规划</span>
              <pre className="hq-log__text">{hqLog.plan}</pre>
            </div>
          )}
          {hqLog.critique && (
            <div className="hq-log__block">
              <span className="hq-log__stage">批改</span>
              {hqLog.critique.ok ? (
                <p className="hq-log__ok">✅ 与既有设定一致，无需修订</p>
              ) : (
                <ul className="hq-log__issues">
                  {hqLog.critique.issues.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              )}
            </div>
          )}
          {hqLog.revising && <p className="hq-log__revising">🔁 正在按批改意见修订…</p>}
          {hqLog.revised && <p className="hq-log__revised">✅ 已按批改意见自动修订</p>}
        </div>
      )}

      {draft && (
        <div className="draft-banner">
          <span className="draft-banner__text">
            📝 检测到上次中断的续写草稿（第 {draft.chapterIndex} 章 · 约 {draft.text.length} 字），可保存为章节继续编辑。
          </span>
          <div className="draft-banner__ops">
            <button type="button" className="btn btn--primary btn--sm" onClick={saveDraftAsChapter}>保存为章节</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={discardDraft}>丢弃</button>
          </div>
        </div>
      )}

      {error && <p className="panel__error">⚠️ {error}</p>}
      {busy && (
        <div className="typing-bar">
          <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
          墨迹未干，AI 正在续写…
        </div>
      )}

      {showHint && (
        <div className="modal-overlay" onClick={() => setShowHint(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">开辟新章</h3>
            <p className="modal__hint">输入章节梗概或开头片段，AI 会以此为参考作为开头或动机。可留空跳过，由 AI 自由发挥。</p>
            <textarea
              className="modal__editor"
              rows={5}
              placeholder="例如：主角在雨夜收到神秘来信……（可留空）"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              autoFocus
            />
            <div className="modal__ops">
              <button className="btn btn--ghost" onClick={() => { setShowHint(false); setHint(''); }}>取消</button>
              <button className="btn btn--primary" onClick={() => {
                const h = hint.trim();
                setShowHint(false);
                setHint('');
                continueWriting(h);
              }}>确定</button>
            </div>
          </div>
        </div>
      )}

      {project.chapters.length === 0 && !busy ? (
        <div className="empty-hint">
          <span>📜</span>
          <p>尚无章节。建议先生成大纲、人设与设定簿，再开始续写第一章。</p>
        </div>
      ) : (
        <ol className="chapter-list">
          {project.chapters.map((c, i) => ({ c, i })).reverse().map(({ c, i }) => (
            <ChapterItem
              key={c.id}
              chapter={c}
              index={i}
              project={project}
              editing={editing === c.id}
              setEditing={setEditing}
              projectId={project.id}
              onChanged={onChanged}
              flash={flash}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function ChapterItem({ chapter, index, project, editing, setEditing, projectId, onChanged, flash }) {
  const [title, setTitle] = useState(chapter.title);
  const [content, setContent] = useState(chapter.content);
  const [notes, setNotes] = useState(chapter.notes || '');
  const [fullscreen, setFullscreen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const editorRef = useRef(null);
  const [aiMode, setAiMode] = useState(null);
  const [aiStyle, setAiStyle] = useState('');
  const [aiBusyLocal, setAiBusyLocal] = useState(false);
  const fsEditorRef = useRef(null);

  // 外部数据更新时同步本地编辑态（仅在非编辑状态，避免覆盖用户未保存的输入）
  useEffect(() => {
    if (!editing) {
      setTitle(chapter.title);
      setContent(chapter.content);
      setNotes(chapter.notes || '');
    }
  }, [chapter.title, chapter.content, chapter.notes, editing]);

  // 全屏时拦截返回键：退出全屏但保持编辑状态（防丢数据）
  useEffect(() => {
    if (!fullscreen) return;
    _chapterFullscreen = true;
    let handle;
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        handle = await App.addListener('backButton', () => setFullscreen(false));
      } catch {}
    })();
    return () => {
      _chapterFullscreen = false;
      if (handle && typeof handle.remove === 'function') handle.remove();
    };
  }, [fullscreen]);

  const save = async () => {
    try {
      await api.updateChapter(projectId, chapter.id, { title, content, notes });
      onChanged(await api.getProject(projectId));
      setFullscreen(false);
      setEditing(null);
      flash('章节已保存 ✓');
    } catch (e) {
      flash('保存失败：' + e.message);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    try {
      await api.deleteChapter(projectId, chapter.id);
      onChanged(await api.getProject(projectId));
      flash('章节已删除');
    } catch (e) {
      flash('删除失败：' + e.message);
    }
  };

  const runAiProcess = async () => {
    const ta = fullscreen ? fsEditorRef.current : editorRef.current;
    const sel = ta && ta.value ? ta.value.substring(ta.selectionStart, ta.selectionEnd) : '';
    setAiBusyLocal(true);
    const label = {
      rewrite: '正在重写本章…',
      expand: '正在扩写…',
      polish: '正在润色…',
      style: '正在换风格…',
    }[aiMode] || 'AI 处理中…';
    setAiBusy(label, abortActiveRequest);
    try {
      const { content: result } = await api.aiPostProcess({
        name: project.name,
        memory: project.memory,
        chapterIndex: index + 1,
        title,
        content,
        mode: aiMode,
        style: aiStyle,
        selection: sel,
      });
      // 整章模式去掉模型可能带出的"第X章 标题"行；选中模式原样替换
      const cleaned = (sel && sel.trim())
        ? result.trim()
        : result.replace(/^(?:\s*#+\s*)?第.+?章[^\n]*\n?/, '').trim() || result;
      if (sel && sel.trim() && ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        setContent(content.slice(0, start) + cleaned + content.slice(end));
      } else {
        setContent(cleaned);
      }
      setAiMode(null);
      flash('AI 处理完成，请检查后保存 ✓');
    } catch (e) {
      if (e.message !== '已取消') flash('AI 处理失败：' + e.message);
    } finally {
      setAiBusyLocal(false);
      clearAiBusy();
    }
  };

  return (
    <li className={`chapter-item reveal ${editing ? 'chapter-item--editing' : ''}`}>
      <div className="chapter-item__head">
        <span className="chapter-item__no">{String(index + 1).padStart(2, '0')}</span>
        {editing ? (
          <input className="chapter-item__title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        ) : (
          <h3>{chapter.title}</h3>
        )}
        <div className="chapter-item__ops">
          {editing ? (
            <>
              <button className="btn btn--primary btn--sm" onClick={save}>保存</button>
              <button className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn--ghost btn--sm" onClick={() => setFullscreen(true)}>🖥️ 全屏</button>
              <button className="btn btn--ghost btn--sm" onClick={() => setAiMode('rewrite')}>✨ AI 处理</button>
            </>
          ) : (
            <>
              <button className="btn btn--ghost btn--sm" onClick={() => setEditing(chapter.id)}>✏️ 编辑</button>
              <button className="btn btn--ghost btn--sm btn--danger" onClick={() => setConfirmRemove(true)}>🗑 删除</button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          ref={editorRef}
          className="chapter-editor"
          rows={14}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      ) : (
        <p className="chapter-item__preview">{chapter.content.slice(0, 120)}…</p>
      )}
      <div className="notes-box notes-box--chapter">
        <label className="notes-box__label">📝 本章随笔（续写下一章时与设定簿一并送入 AI）</label>
        <textarea
          className="notes-box__editor"
          rows={3}
          placeholder="本章铺垫、未完成的线、下章计划……"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if ((chapter.notes || '') !== notes) {
              api.updateChapter(projectId, chapter.id, { notes })
                .then(onChanged)
                .catch((e) => flash('随笔保存失败：' + e.message));
            }
          }}
        />
      </div>
      {editing && fullscreen && createPortal(
        <div className="chapter-fullscreen">
          <header className="chapter-fullscreen__head">
            <span className="chapter-item__no">{String(index + 1).padStart(2, '0')}</span>
            <input className="chapter-item__title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div className="chapter-fullscreen__ops">
              <button className="btn btn--primary btn--sm" onClick={save}>保存</button>
              <button className="btn btn--ghost btn--sm" onClick={() => { setFullscreen(false); setEditing(null); }}>取消</button>
              <button className="btn btn--ghost btn--sm" onClick={() => setFullscreen(false)}>↩️ 退出全屏</button>
              <button className="btn btn--ghost btn--sm" onClick={() => setAiMode('rewrite')}>✨ AI 处理</button>
            </div>
          </header>
          <textarea
            ref={fsEditorRef}
            className="chapter-fullscreen__editor"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            autoFocus
          />
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="删除章节"
        message={`删除「${chapter.title}」？此操作不可恢复。`}
        danger
        confirmText="删除"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={remove}
      />

      {aiMode && createPortal(
        <div className="modal-mask" style={{ zIndex: 300 }} onClick={() => { if (!aiBusyLocal) setAiMode(null); }}>
          <div className="modal modal--ai" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">AI 处理本章</h3>
            <div className="genre-grid">
              {[
                { key: 'rewrite', label: '✍️ 重写本章' },
                { key: 'expand', label: '📈 扩写' },
                { key: 'polish', label: '✨ 润色' },
                { key: 'style', label: '🎨 换风格' },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`genre-btn ${aiMode === m.key ? 'genre-btn--active' : ''}`}
                  onClick={() => setAiMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {aiMode === 'style' && (
              <label className="field">
                <span>目标风格</span>
                <input
                  value={aiStyle}
                  onChange={(e) => setAiStyle(e.target.value)}
                  placeholder="例如：轻松幽默 / 冷峻硬核 / 细腻文艺 / 爽文节奏"
                />
              </label>
            )}
            <p className="modal__hint">在正文中选中文字可只处理选中片段，否则处理整章。</p>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setAiMode(null)}>取消</button>
              <button type="button" className="btn btn--primary" onClick={runAiProcess} disabled={aiBusyLocal}>
                {aiBusyLocal ? '处理中…' : '开始处理'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </li>
  );
}

/* ---------- 讨论面板 ---------- */
// 创作导师上下文截断长度（控制 token）
const CTX_LIMITS = { outline: 1200, characters: 800, foreshadowing: 800, memory: 1200 };

function DiscussPanel({ hidden, project, onPersist, onPatch }) {
  const [messages, setMessages] = useState(
    project.discussions?.length
      ? project.discussions
      : [{ role: 'assistant', content: '你好，作者。聊聊你这部作品吧——卡在哪里，或者想往哪里去？' }]
  );
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingPatch, setPendingPatch] = useState(null);
  const [applyError, setApplyError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy || pendingPatch) return;
    const next = [...messages, { role: 'user', content: text }];
    const streamIdx = next.length;
    // 预置空 assistant 气泡，流式过程中实时追加
    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);
    setAiBusy('创作导师正在思考…', abortActiveRequest);
    try {
      const context = [
        `书名：《${project.name}》（${project.category}）`,
        `核心想法：${project.coreIdea}`,
        `大纲：${project.outline?.slice(0, CTX_LIMITS.outline) || '暂无'}`,
        `角色：${project.characters?.slice(0, CTX_LIMITS.characters) || '暂无'}`,
        `伏笔：${project.foreshadowing?.slice(0, CTX_LIMITS.foreshadowing) || '暂无'}`,
        `设定簿（当下情报）：${project.memory?.slice(0, CTX_LIMITS.memory) || '暂无'}`,
        `最新章节随笔：${project.chapters[project.chapters.length - 1]?.notes?.slice(0, 600) || '暂无'}`,
        `已写章节数：${project.chapters.length}`,
        project.chapters.length > 0
          ? `最新章节：第${project.chapters.length}章「${project.chapters[project.chapters.length - 1].title}」`
          : '',
      ].filter(Boolean).join('\n');
      const { content, toolCalls } = await api.aiDiscuss({
        context,
        messages: next.map(({ role, content }) => ({ role, content })),
        onChunk: (delta) => {
          setMessages((prev) => {
            if (prev.length <= streamIdx) return prev;
            const copy = prev.slice();
            copy[streamIdx] = { ...copy[streamIdx], content: copy[streamIdx].content + delta };
            return copy;
          });
        },
      });

      // 优先用真函数调用（tools）解析修改；模型未发工具调用时回退到旧标记协议
      const parsed = (toolCalls && toolCalls.length)
        ? toolCallsToPatches(toolCalls, project)
        : parsePatches(content, project);
      const { reply, cards, apply } = parsed;

      // 用清理后的回复 + 修改卡片替换流式气泡，等待用户确认后再应用
      const finalMsgs = [...next, { role: 'assistant', content: reply, cards }];
      setMessages(finalMsgs);
      setPendingPatch({ apply, reply, next, cards });
      setApplyError('');
    } catch (e) {
      const note = e.message === '已取消' ? '（已停止生成）' : `（讨论中断：${e.message}）`;
      setMessages([...next, { role: 'assistant', content: note }]);
    } finally {
      setBusy(false);
      clearAiBusy();
    }
  };

  const applyPending = async () => {
    if (!pendingPatch) return;
    const { apply, reply, next, cards } = pendingPatch;
    setBusy(true);
    setApplyError('');
    try {
      let updated = project;
      const projectPatch = {};
      if (apply.outline !== undefined) projectPatch.outline = apply.outline;
      if (apply.characters !== undefined) projectPatch.characters = apply.characters;
      if (apply.foreshadowing !== undefined) projectPatch.foreshadowing = apply.foreshadowing;
      if (apply.memory !== undefined) projectPatch.memory = apply.memory;
      if (Object.keys(projectPatch).length > 0) {
        updated = await api.updateProject(project.id, projectPatch);
      }
      // 应用章节修改（正文 + 标题）：写后端 + 同步本地 chapters
      if (apply.chapters.length > 0 || apply.chapterTitles.length > 0) {
        const newChapters = [...(updated.chapters || project.chapters)];
        for (const cp of apply.chapters) {
          const ch = newChapters[cp.idx];
          if (!ch) continue;
          await api.updateChapter(project.id, ch.id, { content: cp.content });
          newChapters[cp.idx] = { ...ch, content: cp.content };
        }
        for (const tp of apply.chapterTitles) {
          const ch = newChapters[tp.idx];
          if (!ch) continue;
          await api.updateChapter(project.id, ch.id, { title: tp.title });
          newChapters[tp.idx] = { ...ch, title: tp.title };
        }
        updated = { ...updated, chapters: newChapters };
      }
      // 修改最新章节的随笔
      if (apply.notes !== undefined && (updated.chapters || project.chapters).length > 0) {
        const chs = updated.chapters || project.chapters;
        const lastCh = chs[chs.length - 1];
        await api.updateChapter(project.id, lastCh.id, { notes: apply.notes });
        updated = { ...updated, chapters: chs.map((c, i) => (i === chs.length - 1 ? { ...c, notes: apply.notes } : c)) };
      }
      if (updated !== project) onPatch(updated);

      const appliedCards = (cards || []).map((c) => ({ ...c, applied: true }));
      const finalMsgs = [...next, { role: 'assistant', content: reply, cards: appliedCards }];
      setMessages(finalMsgs);
      onPersist(finalMsgs);
      setPendingPatch(null);
    } catch (e) {
      setApplyError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const ignorePending = () => {
    if (!pendingPatch) return;
    const { reply, next, cards } = pendingPatch;
    const finalMsgs = [...next, { role: 'assistant', content: reply, cards: (cards || []).map((c) => ({ ...c, applied: false })) }];
    setMessages(finalMsgs);
    onPersist(finalMsgs);
    setPendingPatch(null);
    setApplyError('');
  };

  return (
    <div className="panel panel--chat" style={{ display: hidden ? 'none' : 'flex' }}>
      <header className="panel__head">
        <div>
          <h2 className="panel__title">创作讨论</h2>
          <p className="panel__hint">AI 导师已读完你的大纲与人设，随时开聊</p>
        </div>
      </header>

      <div className="chat-scroll">
        {messages.map((m, i) => {
          const isStreamingEmpty =
            busy && i === messages.length - 1 && m.role === 'assistant' && !m.content;
          if (m.role === 'user') {
            return (
              <div key={i} className="bubble bubble--user">
                <span className="bubble__avatar">✍️</span>
                <div className="bubble__text">{m.content}</div>
              </div>
            );
          }
          // assistant：分离回复文本与修改卡片（流式中实时解析，流结束后用已存的 cards）
          let replyText = m.content;
          let replyCards = m.cards;
          if (!replyCards) {
            const parsed = parsePatches(m.content, project);
            replyText = parsed.reply;
            replyCards = parsed.cards;
          }
          return (
            <div key={i} className="bubble bubble--assistant">
              <span className="bubble__avatar">🦊</span>
              {isStreamingEmpty ? (
                <div className="bubble__text typing">
                  <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                </div>
              ) : (
                <div className="bubble__content">
                  {replyText && (
                    <div className="bubble__text md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(replyText) }} />
                  )}
                  {replyCards?.length > 0 && replyCards.map((c, ci) => (
                    <div key={ci} className="patch-card">
                      <div className="patch-card__label">
                        {c.label}
                        {c.applied === true && <span className="patch-card__badge patch-card__badge--ok">已应用</span>}
                        {c.applied === false && <span className="patch-card__badge">未应用</span>}
                      </div>
                      <div className="patch-card__body md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {pendingPatch && (
        <div className="discuss-confirm">
          <div className="discuss-confirm__text">
            AI 导师提出了 {pendingPatch.cards?.length || 0} 项修改，确认后才会写入作品。
            {applyError && <span className="discuss-confirm__err">应用失败：{applyError}</span>}
          </div>
          <div className="discuss-confirm__ops">
            <button type="button" className="btn btn--primary btn--sm" onClick={applyPending} disabled={busy}>
              {busy ? '应用中…' : '应用修改'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={ignorePending}>忽略</button>
          </div>
        </div>
      )}

      <div className="chat-input">
        <textarea
          rows={2}
          placeholder="例如：反派的动机是不是太单薄了？（Enter 发送，Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn--primary" onClick={send} disabled={busy || !input.trim() || !!pendingPatch}>
          发送 ↵
        </button>
      </div>
    </div>
  );
}
