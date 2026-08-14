import { useEffect, useState } from 'react';
import { getKey, saveKey, loadKey, getThinking, saveThinking, testKey, abortActiveRequest } from '../services/deepseek.js';
import { setAiBusy, clearAiBusy } from '../services/aiBusy.js';

export default function KeySettings({ onClose }) {
  const [key, setKey] = useState(getKey());
  const [thinking, setThinking] = useState(getThinking());
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

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
    await saveKey(key);
    saveThinking(thinking);
    setSaved(true);
    setTimeout(onClose, 700);
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
              autoFocus
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
          🔒 Key 仅保存在本机，不会上传到任何服务器。<br />
          前往 <b>platform.deepseek.com</b> 创建密钥，按量计费，写一本小说也就几毛钱。
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
        <p className="settings__note">
          开启后模型会先进行深度推理再输出，适合复杂创作任务。<br />
          注意：思考模式会消耗更多 token，费用略高。
        </p>

        {saved && <p className="settings__ok">✓ 墨已研好</p>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn--primary">保存</button>
        </div>
      </form>
    </div>
  );
}
