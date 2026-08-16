import { useEffect, useState } from 'react';
import { getKey, saveKey, loadKey, getThinking, saveThinking, getHqMode, saveHqMode, testKey, abortActiveRequest } from '../services/deepseek.js';
import { setAiBusy, clearAiBusy } from '../services/aiBusy.js';

export default function KeySettings({ onClose }) {
  const [key, setKey] = useState(getKey());
  const [thinking, setThinking] = useState(getThinking());
  const [hq, setHq] = useState(getHqMode());
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState('');

  // 原生端 Key 可能来自安全存储，进入设置时异步刷新一次
  useEffect(() => {
    loadKey().then(() => setKey(getKey()));
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      // 超时兜底：任何环节卡住都不让保存流程悬挂
      const res = await Promise.race([
        saveKey(key),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: '保存超时，请重试' }), 6000)),
      ]);
      saveThinking(thinking);
      saveHqMode(hq);
      if (!res?.ok) {
        setError('保存失败：' + (res?.message || '未知错误'));
        return; // 不关闭弹窗，让用户看到错误
      }
      setSaved(true);
      setTimeout(onClose, 700);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setAiBusy('正在检测 Key 连通性…', abortActiveRequest);
    try {
      const res = await testKey(key);
      setTestResult(res);
      if (res.ok) await saveKey(key); // 验证通过后顺手保存，减少一步操作
    } finally {
      setTesting(false);
      clearAiBusy();
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal__title">研墨设置</h2>
        <label className="field">
          <span>DeepSeek API Key</span>
          <div className="key-input-row">
            <input
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              placeholder="sk-…"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setTestResult(null);
              }}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm key-eye"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? '隐藏密钥' : '显示密钥'}
            >
              {showKey ? '🙈' : '👁️'}
            </button>
          </div>
        </label>
        <p className="settings__note">
          🔒 Key 仅存本机，不会上传。<b>platform.deepseek.com</b> 创建，按量计费。
        </p>

        <div className="settings__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={test} disabled={testing || !key.trim()}>
            {testing ? '检测中…' : '🩺 测试 Key'}
          </button>
        </div>
        {testResult && (
          <p className={`settings__test ${testResult.ok ? 'settings__test--ok' : 'settings__test--err'}`}>
            {testResult.ok ? '✅' : '❌'} {testResult.message}
          </p>
        )}

        <div className="field">
          <span>思考模式</span>
          <button
            type="button"
            className={`thinking-toggle ${thinking ? 'thinking-toggle--on' : ''}`}
            onClick={() => setThinking(!thinking)}
          >
            {thinking ? '🧠 已开启' : '💭 未开启'}
          </button>
        </div>
        <p className="settings__note">开启后模型先深度推理再输出，适合复杂任务；消耗更多 token。</p>

        <div className="field">
          <span>高质量模式</span>
          <button
            type="button"
            className={`thinking-toggle ${hq ? 'thinking-toggle--on' : ''}`}
            onClick={() => setHq(!hq)}
          >
            {hq ? '🛡️ 已开启' : '⚡ 未开启'}
          </button>
        </div>
        <p className="settings__note">续写走「规划 → 草稿 → 批改」：写前规划、写后自动一致性批改，不通过即修订。质量更高，耗时与费用略增。</p>

        {error && <p className="settings__test settings__test--err">⚠️ {error}</p>}
        {saved && <p className="settings__ok">✓ 墨已研好</p>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
