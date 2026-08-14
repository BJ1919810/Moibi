/**
 * 全局 AI 忙碌状态（供底部状态条显示与停止）。
 * 使用轻量发布订阅，避免跨组件层层传参。
 */
let state = { text: '', abort: null };
const listeners = new Set();

const emit = () => {
  for (const fn of listeners) fn(state);
};

export function setAiBusy(text, abort = null) {
  state = { text, abort };
  emit();
}

export function clearAiBusy() {
  state = { text: '', abort: null };
  emit();
}

export function getAiBusy() {
  return state;
}

export function subscribeAiBusy(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
