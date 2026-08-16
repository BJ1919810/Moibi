import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

export const GENRES = [
  '玄幻', '奇幻', '仙侠', '武侠', '科幻', '都市', '历史', '军事', '悬疑', '现实',
  '系统流', '废柴流', '种田', '基建', '无限流', '快穿', '穿书', '重生', '末世', '废土',
  '同人', '二次元', '轻小说',
  '搞笑', '轻松', '热血', '黑暗', '甜宠', '治愈', '正剧', '沙雕', '虐心',
  '修真', '青春校园', '言情', '恐怖', '诡秘怪谈', '灵气复苏', '游戏', '诸天无限',
];

/** 分类分组（新建/编辑作品时的选择器展示）：大题材背景 / 核心设定与展开模式 / 衍生与文风 */
export const GENRES_SECTIONS = [
  { title: '大题材背景', tags: ['玄幻', '奇幻', '仙侠', '武侠', '科幻', '都市', '历史', '军事', '悬疑', '现实'] },
  { title: '核心设定 · 展开模式', tags: ['系统流', '废柴流', '种田', '基建', '无限流', '快穿', '穿书', '重生', '末世', '废土'] },
  { title: '衍生', tags: ['同人', '二次元', '轻小说'] },
  { title: '文风基调', tags: ['搞笑', '轻松', '热血', '黑暗', '甜宠', '治愈', '正剧', '沙雕', '虐心'] },
  { title: '其他常用', tags: ['修真', '青春校园', '言情', '恐怖', '诡秘怪谈', '灵气复苏', '游戏', '诸天无限'] },
];

export default function HomePage({ onOpen }) {
  const [projects, setProjects] = useState([]);
  const [categories, setCategories] = useState(['全部']);
  const [selectedTags, setSelectedTags] = useState([]);
  const [showFilter, setShowFilter] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [toast, setToast] = useState('');

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  const reqIdRef = useRef(0);
  const refresh = async (tags = selectedTags) => {
    const id = ++reqIdRef.current;
    try {
      const [list, cats] = await Promise.all([api.listProjects(tags), api.listCategories()]);
      if (id !== reqIdRef.current) return; // 被后续请求取代，丢弃过期结果
      setProjects(list);
      setCategories(cats);
      setError('');
    } catch (e) {
      if (id === reqIdRef.current) setError(e.message || '书架加载失败');
    }
  };

  useEffect(() => {
    refresh([]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTags = (tags) => {
    setSelectedTags(tags);
    refresh(tags);
  };

  const toggleTag = (tag) => {
    return selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag];
  };

  const singleTags = categories.filter((c) => c !== '全部');

  const handleDeleteClick = (e, project) => {
    e.stopPropagation();
    setDeleteTarget(project);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await api.deleteProject(deleteTarget.id);
    setDeleteTarget(null);
    refresh();
  };

  const handleBackup = async (e, project) => {
    e.stopPropagation();
    try {
      flash(await api.backupProject(project));
    } catch (err) {
      flash('备份失败：' + err.message);
    }
  };

  return (
    <main className="home">
      <header className="home__hero">
        <div className="home__hero-text">
          <p className="home__kicker">AI 小说创作坊</p>
          <h1 className="home__title">
            落笔之前，<em>先有乾坤</em>
          </h1>
          <p className="home__sub">一句话灵感 → 大纲 · 人设 · 伏笔 · 章节续写，一站式完成</p>
          <button className="btn btn--primary btn--lg" onClick={() => setShowCreate(true)}>
            ✒️ 开辟新作
          </button>
        </div>
        <div className="home__seal" aria-hidden="true">
          <span className="home__seal-line">胸藏文墨虚若谷</span>
          <span className="home__seal-line home__seal-line--accent">腹有诗书气自华</span>
          <i className="home__seal-stamp">墨笔</i>
        </div>
      </header>

      <nav className="chips">
        <button
          className={`chip ${selectedTags.length === 0 ? 'chip--active' : ''}`}
          onClick={() => applyTags([])}
        >
          全部
        </button>
        {singleTags.length <= 4 ? (
          singleTags.map((t) => (
            <button
              key={t}
              className={`chip ${selectedTags.includes(t) ? 'chip--active' : ''}`}
              onClick={() => applyTags(toggleTag(t))}
            >
              {t}
            </button>
          ))
        ) : (
          <button
            className={`chip chip--filter ${selectedTags.length ? 'chip--active' : ''}`}
            onClick={() => setShowFilter(true)}
            title="多选筛选分类"
          >
            {selectedTags.length ? `筛选（${selectedTags.length}）` : '筛选'}
          </button>
        )}
      </nav>

      {error && <p className="home__error">⚠️ {error}</p>}

      {loading ? (
        <p className="home__empty">研 墨 中 …</p>
      ) : projects.length === 0 ? (
        <div className="home__empty-card">
          <span className="home__empty-glyph">砚</span>
          <p>书案尚空，点击「开辟新作」落下第一笔</p>
        </div>
      ) : (
        <section className="shelf">
          {projects.map((p, i) => (
            <article
              key={p.id}
              className="book-card reveal"
              style={{ animationDelay: `${i * 60}ms` }}
              onClick={() => onOpen(p.id)}
            >
              <div className="book-card__spine" />
              <div className="book-card__body">
                <span className="book-card__cat">{p.category}</span>
                <h3 className="book-card__name">《{p.name}》</h3>
                <p className="book-card__idea">{p.coreIdea || '暂无灵感记录'}</p>
                <footer className="book-card__meta">
                  <span>📖 {p.chapters.length} 章</span>
                  <span>{new Date(p.updatedAt).toLocaleDateString('zh-CN')}</span>
                </footer>
              </div>
              <button className="book-card__backup" title="备份为 JSON" onClick={(e) => handleBackup(e, p)}>⬇</button>
              <button className="book-card__del" title="删除" onClick={(e) => handleDeleteClick(e, p)}>✕</button>
            </article>
          ))}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            onOpen(id);
          }}
        />
      )}

      <ImportModal
        onImported={(id) => {
          refresh();
          onOpen(id);
        }}
      />

      {showFilter && (
        <div className="modal-mask" onClick={() => setShowFilter(false)}>
          <div className="modal modal--filter" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">筛选分类</h3>
            <p className="modal__hint">可多选，作品需同时满足所选分类才会显示</p>
            <div className="genre-grid">
              <div className="genre-sec">
                <span className="genre-sec__label">已有分类</span>
                <div className="genre-sec__tags">
                  {singleTags.map((t) => (
                    <button
                      type="button"
                      key={t}
                      className={`genre-btn ${selectedTags.includes(t) ? 'genre-btn--active' : ''}`}
                      onClick={() => applyTags(toggleTag(t))}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => applyTags([])}>清除筛选</button>
              <button type="button" className="btn btn--primary" onClick={() => setShowFilter(false)}>完成</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除作品"
        message={deleteTarget ? `确定删除《${deleteTarget.name}》吗？此操作不可恢复。` : ''}
        danger
        confirmText="删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </main>
  );
}

function CreateModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', coreIdea: '' });
  const [selectedGenres, setSelectedGenres] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleGenre = (g) => {
    setSelectedGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('请先给作品起个名字');
    if (!form.coreIdea.trim()) return setError('写下一句核心想法，AI 才能为你展开乾坤');
    setBusy(true);
    setError('');
    try {
      const project = await api.createProject({
        name: form.name.trim(),
        category: selectedGenres.length ? selectedGenres.join('/') : '未分类',
        coreIdea: form.coreIdea.trim(),
      });
      onCreated(project.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal__title">开辟新作</h2>

        <label className="field">
          <span>作品名称</span>
          <input
            autoFocus
            maxLength={30}
            placeholder="例如：长夜提灯人"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>

        <div className="field">
          <span>分类（可多选）</span>
          <button
            type="button"
            className={`genre-display ${selectedGenres.length ? 'genre-display--filled' : ''}`}
            onClick={() => setShowPicker((v) => !v)}
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

        <label className="field">
          <span>核心想法（一句话灵感）</span>
          <textarea
            rows={4}
            maxLength={300}
            placeholder="例如：一个只能看见别人死亡倒计时的少年，发现自己头顶的数字是负数。"
            value={form.coreIdea}
            onChange={(e) => setForm({ ...form, coreIdea: e.target.value })}
          />
        </label>

        {error && <p className="modal__error">⚠️ {error}</p>}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? '落笔中…' : '开始创作 →'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- 导入 TXT 浮窗 ---------- */
function ImportModal({ onImported }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);
  const restoreRef = useRef(null);
  const pendingFileRef = useRef(null);

  // 预览弹窗支持 Esc 关闭
  useEffect(() => {
    if (!preview) return;
    const onKey = (e) => { if (e.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.name.endsWith('.txt')) {
      setError('仅支持 .txt 文件');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // 先解析预览，不落库
      const parsed = await api.previewTxt(file);
      pendingFileRef.current = file;
      setPreview(parsed);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    const file = pendingFileRef.current;
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const project = await api.importTxt(file);
      setPreview(null);
      pendingFileRef.current = null;
      onImported(project.id);
    } catch (e) {
      setError(e.message);
      setPreview(null);
      pendingFileRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError('仅支持 .json 备份文件');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const project = await api.importBackupFile(file);
      onImported(project.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-bar">
      <input
        ref={fileRef}
        type="file"
        accept=".txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFile(e.target.files[0]);
          e.target.value = '';
        }}
      />
      <div
        className={`import-dropzone ${dragOver ? 'import-dropzone--over' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFile(e.dataTransfer.files[0]);
        }}
      >
        {busy ? (
          <span className="import-busy">📂 正在导入…</span>
        ) : (
          <>
            <span className="import-icon">📂</span>
            <span className="import-text">导入已有 TXT 文件</span>
            <span className="import-hint">点击选择或拖拽文件到此处 · 支持 .txt · 限 2MB 以内 · 自动识别书名与章节</span>
          </>
        )}
      </div>
      {error && <p className="import-error">⚠️ {error}</p>}

      <div className="import-restore">
        <span>或</span>
        <input
          ref={restoreRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            handleRestore(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => restoreRef.current?.click()}
          disabled={busy}
        >
          📦 从备份恢复（.json）
        </button>
      </div>

      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <div className="modal modal--preview" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">确认导入</h3>
            <p className="modal__hint">
              书名：<b>{preview.project.name}</b><br />
              章节数：{preview.chapters.length} 章<br />
              灵感：{preview.project.coreIdea || '（无）'}
            </p>
            {preview.chapters.length > 0 && (
              <ul className="preview-chapters">
                {preview.chapters.slice(0, 5).map((c, i) => (
                  <li key={i}>{c.title}</li>
                ))}
                {preview.chapters.length > 5 && (
                  <li>…… 共 {preview.chapters.length} 章</li>
                )}
              </ul>
            )}
            <p className="modal__hint">
              导入后建议：先在「设定簿」页点「从正文抽取」，再生成大纲 / 人设 / 伏笔，创作讨论可随时修改。
            </p>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setPreview(null)}>取消</button>
              <button type="button" className="btn btn--primary" onClick={confirmImport} disabled={busy}>
                {busy ? '导入中…' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
