import { useState, useCallback, useEffect } from 'react';
import HomePage from './pages/HomePage.jsx';
import ProjectPage from './pages/ProjectPage.jsx';
import KeySettings from './components/KeySettings.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import AiStatusBar from './components/AiStatusBar.jsx';
import { getKey, loadKey } from './services/deepseek.js';
import { isChapterFullscreen } from './pages/ProjectPage.jsx';

export default function App() {
  const [projectId, setProjectId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [keySet, setKeySet] = useState(!!getKey());

  // 启动时从安全存储加载 Key（原生端），并同步按钮状态
  useEffect(() => {
    loadKey().then(() => setKeySet(!!getKey()));
  }, []);

  const openProject = useCallback((id) => setProjectId(id), []);
  const goHome = useCallback(() => setProjectId(null), []);
  const closeSettings = () => {
    setShowSettings(false);
    setKeySet(!!getKey());
  };

  // Android 返回键：返回上一级
  useEffect(() => {
    let cancelled = false;
    let handle = null;
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        if (cancelled) return;
        handle = await App.addListener('backButton', () => {
          if (isChapterFullscreen()) return; // 章节全屏时退出全屏（由 ChapterItem 处理）
          if (projectId) goHome();
          else App.exitApp();
        });
      } catch {
        // 非 Capacitor 环境（浏览器调试）不处理
      }
    })();
    return () => {
      cancelled = true;
      if (handle && typeof handle.remove === 'function') handle.remove();
    };
  }, [projectId, goHome]);

  return (
    <div className="app-shell">
      <BackgroundInk />
      <ErrorBoundary>
        {projectId ? (
          <ProjectPage projectId={projectId} onBack={goHome} />
        ) : (
          <HomePage onOpen={openProject} />
        )}
      </ErrorBoundary>

      <AiStatusBar />

      <button
        className={`settings-fab ${keySet ? 'settings-fab--ok' : ''}`}
        title="设置 API Key"
        onClick={() => setShowSettings(true)}
      >
        ⚙️
      </button>
      {showSettings && <KeySettings onClose={closeSettings} />}
    </div>
  );
}

function BackgroundInk() {
  return (
    <div className="bg-layer" aria-hidden="true">
      <span className="bg-char bg-char--1">灵</span>
      <span className="bg-char bg-char--2">墨</span>
      <span className="bg-char bg-char--3">章</span>
      <span className="bg-char bg-char--4">笔</span>
    </div>
  );
}
