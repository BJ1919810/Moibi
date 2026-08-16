import { useEffect, useState } from 'react';

const ROLE_OPTIONS = ['主角', '配角', '反派'];
const STATUS_OPTIONS = [
  { value: 'alive', label: '存活' },
  { value: 'dead', label: '死亡' },
  { value: 'missing', label: '失踪' },
  { value: 'changed', label: '已变化' },
];

/** 角色卡编辑弹窗：card 为 null 时新建；card 为已有卡时在副本上编辑 */
export default function CharacterCardEditor({ card, onCancel, onSave }) {
  const [form, setForm] = useState(() => ({
    name: card?.name || '',
    aliases: (card?.aliases || []).join('、'),
    role: card?.role || '配角',
    gender: card?.gender || '',
    age: card?.age || '',
    identity: card?.identity || '',
    appearance: card?.appearance || '',
    personality: card?.personality || '',
    motivation: card?.motivation || '',
    arc: card?.arc || '',
    abilities: (card?.abilities || []).join('、'),
    relationships: (card?.relationships || []).map((r) => ({ ...r })),
    status: card?.status || 'alive',
    statusNote: card?.statusNote || '',
    highlight: card?.highlight || '',
  }));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setRel = (i, k, v) => setForm((f) => ({
    ...f,
    relationships: f.relationships.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)),
  }));
  const addRel = () => setForm((f) => ({ ...f, relationships: [...f.relationships, { name: '', relation: '', note: '' }] }));
  const delRel = (i) => setForm((f) => ({ ...f, relationships: f.relationships.filter((_, idx) => idx !== i) }));

  const submit = (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return setError('请填写角色姓名');
    onSave({
      ...(card || {}),
      name,
      aliases: form.aliases.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean),
      role: form.role,
      gender: form.gender.trim(),
      age: form.age.trim(),
      identity: form.identity.trim(),
      appearance: form.appearance.trim(),
      personality: form.personality.trim(),
      motivation: form.motivation.trim(),
      arc: form.arc.trim(),
      abilities: form.abilities.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean),
      relationships: form.relationships
        .map((r) => ({ name: r.name.trim(), relation: r.relation.trim(), note: r.note.trim() }))
        .filter((r) => r.name),
      status: form.status,
      statusNote: form.statusNote.trim(),
      highlight: form.highlight.trim(),
    });
  };

  const input = (k, placeholder, props = {}) => (
    <input
      value={form[k]}
      placeholder={placeholder}
      onChange={(e) => set(k, e.target.value)}
      {...props}
    />
  );
  const area = (k, placeholder, rows = 3) => (
    <textarea
      rows={rows}
      value={form[k]}
      placeholder={placeholder}
      onChange={(e) => set(k, e.target.value)}
    />
  );

  return (
    <div className="modal-mask" style={{ zIndex: 200 }} onClick={onCancel}>
      <form className="modal modal--wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal__title">{card ? `编辑角色卡：${card.name}` : '新建角色卡'}</h2>

        <div className="cc-form">
          <section className="cc-sec">
            <h4 className="cc-sec__title">基础</h4>
            <div className="cc-row">
              <label className="field"><span>姓名 *</span>{input('name', '例如：沈夜')}</label>
              <label className="field"><span>别名</span>{input('aliases', '用顿号分隔，如：夜枭、小夜')}</label>
            </div>
            <div className="cc-row">
              <label className="field">
                <span>阵营</span>
                <select value={form.role} onChange={(e) => set('role', e.target.value)}>
                  {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="field"><span>性别</span>{input('gender', '男 / 女 / 其他')}</label>
              <label className="field"><span>年龄</span>{input('age', '未知 / 22')}</label>
            </div>
            <label className="field"><span>身份 / 称号</span>{input('identity', '例如：灰烬楼的守夜人')}</label>
          </section>

          <section className="cc-sec">
            <h4 className="cc-sec__title">形象</h4>
            <label className="field"><span>外貌特征</span>{area('appearance', '外貌、衣着、气质……', 2)}</label>
          </section>

          <section className="cc-sec">
            <h4 className="cc-sec__title">内在</h4>
            <label className="field"><span>性格</span>{area('personality', '性格底色与矛盾点……', 3)}</label>
            <label className="field"><span>核心动机</span>{area('motivation', '驱动他行动的根本欲望或恐惧……', 2)}</label>
            <label className="field"><span>人物弧光</span>{area('arc', '成长轨迹：从什么变成什么……', 2)}</label>
          </section>

          <section className="cc-sec">
            <h4 className="cc-sec__title">能力</h4>
            <label className="field"><span>能力 / 技能</span>{input('abilities', '用顿号分隔，如：读秒、夜视')}</label>
          </section>

          <section className="cc-sec">
            <h4 className="cc-sec__title">关系网</h4>
            {form.relationships.length === 0 && <p className="cc-sec__empty">暂无关系记录</p>}
            {form.relationships.map((r, i) => (
              <div key={i} className="cc-rel-card">
                <div className="cc-rel-card__head">
                  <span className="cc-rel-card__index">{i + 1}</span>
                  <span className="cc-rel-card__pair">
                    {r.name ? (
                      <>
                        {r.name}
                        {r.relation && <span className="cc-rel-card__rel">{r.relation}</span>}
                      </>
                    ) : '新关系'}
                  </span>
                  <button type="button" className="cc-rel__del" title="删除此关系" onClick={() => delRel(i)}>✕</button>
                </div>
                <div className="cc-rel-card__fields">
                  <label className="cc-rel-field">
                    <span>对方姓名</span>
                    <input value={r.name} placeholder="角色姓名" onChange={(e) => setRel(i, 'name', e.target.value)} />
                  </label>
                  <label className="cc-rel-field">
                    <span>关系</span>
                    <input value={r.relation} placeholder="如：宿敌 / 挚友 / 师徒" onChange={(e) => setRel(i, 'relation', e.target.value)} />
                  </label>
                  <label className="cc-rel-field cc-rel-field--wide">
                    <span>简述（可选）</span>
                    <input value={r.note} placeholder="恩怨、相处方式、立场……" onChange={(e) => setRel(i, 'note', e.target.value)} />
                  </label>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn--ghost btn--sm" onClick={addRel}>＋ 添加关系</button>
          </section>

          <section className="cc-sec">
            <h4 className="cc-sec__title">状态</h4>
            <div className="cc-row">
              <label className="field">
                <span>当前状态</span>
                <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                  {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <label className="field"><span>状态备注</span>{input('statusNote', '如：第12章获得读秒能力')}</label>
            </div>
            <label className="field"><span>高光时刻</span>{input('highlight', '如：中盘爆发 / 终局前揭示身世')}</label>
          </section>
        </div>

        {error && <p className="modal__error">⚠️ {error}</p>}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>取消</button>
          <button type="submit" className="btn btn--primary">保存角色卡</button>
        </div>
      </form>
    </div>
  );
}
