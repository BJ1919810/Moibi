import { Component } from 'react';

/**
 * 全局渲染异常兜底：任意子树渲染抛错时显示降级 UI，避免整页白屏。
 * 不拦截事件回调里的异常（那些需自行 try/catch）。
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('渲染异常：', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: '#5a4a3a' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>墨</div>
          <p style={{ fontSize: 16, marginBottom: 8 }}>笔尖一滞，渲染出错了</p>
          <pre style={{ fontSize: 12, color: '#9a6a5a', whiteSpace: 'pre-wrap', margin: '0 auto 16px', maxWidth: 480 }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            重新展卷
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
