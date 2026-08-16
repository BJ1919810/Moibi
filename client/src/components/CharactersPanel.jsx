import { useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { setAiBusy, clearAiBusy } from '../services/aiBusy.js';
import { abortActiveRequest } from '../services/deepseek.js';
import { renderCardsToText, parseLegacyCharacters, buildCharacterBackup, parseCharacterBackup, uid } from '../services/characterCards.js';
import CharacterCardEditor from './CharacterCardEditor.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

const STATUS_META = {
  alive: { label: '存活', cls: 'st-alive' },
  dead: { label: '死亡', cls: 'st-dead' },
  missing: { label: '失踪', cls: 'st-missing' },
  changed: { label: '已变化', cls: 'st-changed' },
};

/** 角色设定面板：结构化角色卡网格 + AI 生成 + 手动编辑 + 旧文本转换 + 单卡导入导出 */
export default function CharactersPanel({ hidden, project, onChanged, flash }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 已有卡 | {}（新建）
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [convertAsk, setConvertAsk] = useState(false);
  const importRef = useRef(null);

  const cards = project.characterCards || [];

  const persist = async (next) => {
    const updated = await api.updateProject(project.id, {
      characterCards: next,
      characters: renderCardsToText(next),
    });
    onChanged(updated);
    return updated;
  };

  const generate = async () => {
    setBusy(true);
    setError('');
    setAiBusy('正在塑造人物…', abortActiveRequest);
    try {
      const { cards: list } = await api.aiCharacters({
        name: project.name, category: project.category,
        coreIdea: project.coreIdea, outline: project.outline, memory: project.memory,
      });
      if (Array.isArray(list) && list.length) {
        await persist(list);
        flash(`角色卡已生成（${list.length} 张）✓`);
      } else {
        setError('AI 返回的角色卡为空，请重试');
      }
    } catch (e) {
      if (e.message !== '已取消') setError(e.message);
    } finally {
      setBusy(false);
      clearAiBusy();
    }
  };

  const saveCard = async (card) => {
    const now = Date.now();
    if (editing && editing.id) {
      await persist(cards.map((c) => (c.id === editing.id ? { ...card, id: editing.id, updatedAt: now } : c)));
    } else {
      await persist([...cards, { ...card, id: uid(), createdAt: now, updatedAt: now }]);
    }
    setEditing(null);
    flash('角色卡已保存 ✓');
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const next = cards.filter((c) => c.id !== deleteTarget.id);
    setDeleteTarget(null);
    await persist(next);
    flash('角色卡已删除');
  };

  const exportCard = async (card) => {
    const text = buildCharacterBackup(card);
    const fileName = `${card.name}.moibi.character.json`;
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (Capacitor.isNativePlatform()) {
        const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
        const { Share } = await import('@capacitor/share');
        const result = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
        await Share.share({ title: '导出角色卡', text: `${card.name} - 墨笔角色卡`, url: result.uri, dialogTitle: '保存角色卡到…' });
        return;
      }
    } catch (e) {
      if (/cancel{1,2}ed/i.test(e?.message || '')) return;
    }
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
    a.click();
    URL.revokeObjectURL(url);
    flash('角色卡已导出 ✓');
  };

  const handleImport = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError('仅支持 .json 角色卡文件');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const buf = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsArrayBuffer(file);
      });
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buf)).replace(/^\uFEFF/, '');
      const card = parseCharacterBackup(text);
      const now = Date.now();
      await persist([...cards, { ...card, id: uid(), createdAt: now, updatedAt: now }]);
      flash(`已导入角色卡「${card.name}」✓`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const convertLegacy = async () => {
    const list = parseLegacyCharacters(project.characters);
    setConvertAsk(false);
    if (list.length === 0) {
      flash('未能从旧文本中拆出角色卡，可点「手动新建」逐张创建');
      return;
    }
    await persist(list);
    flash(`已从旧文本转换 ${list.length} 张角色卡（仅供参考，建议逐张检查）`);
  };

  return (
    <div className="panel" style={{ display: hidden ? 'none' : 'flex' }}>
      <header className="panel__head">
        <div>
          <h2 className="panel__title">角色设定</h2>
          <p className="panel__hint">结构化角色卡：AI 生成、手动编辑；续写新章后按【设定更新】自动同步能力 / 状态 / 关系</p>
        </div>
        <div className="panel__actions">
          {project.characters && cards.length === 0 && (
            <button className="btn btn--ghost" onClick={() => setConvertAsk(true)} disabled={busy}>📚 从旧文本转换</button>
          )}
          <button className="btn btn--ghost" onClick={() => setEditing({})} disabled={busy}>➕ 手动新建</button>
          <button className="btn btn--ghost" onClick={() => importRef.current?.click()} disabled={busy}>📥 导入卡片</button>
          <button className="btn btn--primary" onClick={generate} disabled={busy}>
            {busy ? <span className="spinner" /> : '✨'} {busy ? '正在塑造人物…' : (cards.length ? '重新生成' : 'AI 生成')}
          </button>
        </div>
      </header>

      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => { handleImport(e.target.files[0]); e.target.value = ''; }}
      />

      {error && <p className="panel__error">⚠️ {error}</p>}
      {busy && (
        <div className="typing-bar">
          <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
          正在塑造人物…
        </div>
      )}

      {cards.length === 0 && !busy ? (
        <div className="empty-hint">
          <span>🎭</span>
          <p>
            {project.characters
              ? '已有旧版角色设定文本，可「从旧文本转换」为角色卡，或直接用 AI 生成卡片覆盖。'
              : '尚无角色卡。点击「AI 生成」让 AI 设计主角团、配角与反派，或点下方「手动新建」逐张创建。'}
          </p>
          <button className="btn btn--ghost" onClick={() => setEditing({})}>➕ 手动新建角色卡</button>
        </div>
      ) : (
        <div className="card-grid">
          {cards.map((c) => {
            const st = STATUS_META[c.status] || STATUS_META.alive;
            const desc = (c.personality || c.motivation || '').trim();
            return (
              <article key={c.id} className="char-card" tabIndex={0}>
                <div className="char-card__head">
                  <span className="char-card__avatar">{c.name ? c.name.slice(0, 1) : '？'}</span>
                  <div className="char-card__title">
                    <h3 className="char-card__name">{c.name}</h3>
                    <span className="char-card__role">{c.role}</span>
                  </div>
                  <span className={`char-card__status ${st.cls}`}>{st.label}</span>
                </div>
                {c.identity && <p className="char-card__identity">{c.identity}</p>}
                {c.abilities?.length > 0 && (
                  <div className="char-card__tags">
                    {c.abilities.map((a, i) => <span key={i} className="tag">{a}</span>)}
                  </div>
                )}
                <p className="char-card__desc">{desc.slice(0, 90)}{desc.length > 90 ? '…' : ''}</p>
                <footer className="char-card__foot">
                  <span className="char-card__meta">
                    {c.relationships?.length ? `关系 ${c.relationships.length}` : ''}
                    {c.highlight ? ` · ${c.highlight}` : ''}
                    {c.statusNote ? ` · ${c.statusNote.slice(0, 16)}${c.statusNote.length > 16 ? '…' : ''}` : ''}
                  </span>
                  <div className="char-card__ops">
                    <button className="btn btn--ghost btn--sm" title="编辑" onClick={() => setEditing(c)}>✏️</button>
                    <button className="btn btn--ghost btn--sm" title="导出单卡" onClick={() => exportCard(c)}>⬇</button>
                    <button className="btn btn--ghost btn--sm btn--danger" title="删除" onClick={() => setDeleteTarget(c)}>🗑</button>
                  </div>
                </footer>
              </article>
            );
          })}
          <button className="char-card char-card--new" onClick={() => setEditing({})}>
            <span className="char-card__plus">＋</span>
            <span>新建角色卡</span>
          </button>
        </div>
      )}

      {editing && (
        <CharacterCardEditor
          card={editing.id ? editing : null}
          onCancel={() => setEditing(null)}
          onSave={saveCard}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除角色卡"
        message={deleteTarget ? `确定删除角色「${deleteTarget.name}」吗？此操作不可恢复。` : ''}
        danger
        confirmText="删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />

      <ConfirmDialog
        open={convertAsk}
        title="从旧文本转换"
        message="将尝试从现有「角色设定」文本中拆分为角色卡；自动拆分仅供参考，建议转换后逐张检查。继续？"
        confirmText="转换"
        onCancel={() => setConvertAsk(false)}
        onConfirm={convertLegacy}
      />
    </div>
  );
}
