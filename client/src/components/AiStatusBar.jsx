import { useEffect, useState } from 'react';
import { subscribeAiBusy } from '../services/aiBusy.js';

/** 全局悬浮状态条：显示 AI 当前正在做什么，并提供“停止”按钮 */
export default function AiStatusBar() {
  const [busy, setBusy] = useState(null);

  useEffect(() => subscribeAiBusy(setBusy), []);

  if (!busy?.text) return null;
  return (
    <div className="ai-status" role="status" aria-live="polite">
      <span className="ai-status__dots"><i /><i /><i /></span>
      <span className="ai-status__text">{busy.text}</span>
      <button
        type="button"
        className="ai-status__stop"
        onClick={() => busy.abort?.()}
      >
        停止
      </button>
    </div>
  );
}
