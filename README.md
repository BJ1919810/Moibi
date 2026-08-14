# 墨笔 Moibi · AI 小说创作坊

一句话灵感 → 大纲 / 人设 / 伏笔 / 设定簿 / 章节续写 / 创作讨论，一站式完成长篇网文创作。

React 18 + Vite 5 + Capacitor 8，支持 **Web 与 Android（APK）**，AI 调用 DeepSeek API（SSE 流式，可选思考模式）。

## ✨ 功能

- **一句话灵感开书**：输入核心想法，AI 推演完整小说设定
- **创作模块**：
  - 剧情大纲 · 角色设定 · 伏笔设计（互相引用，保证一致性）
  - **设定簿**：已确认事实档案（能力 / 物品 / 关系 / 地点），续写自动同步、可 AI 整理压缩、可从正文一键抽取
  - **章节续写**：两轮对话生成（正文 + 随笔 → 设定更新），内置断点草稿，中断可续
  - **章节后处理**：重写 / 扩写 / 润色 / 换风格，支持只处理选中片段
  - **创作讨论**：与 AI 导师对话，就地修改大纲 / 人设 / 伏笔 / 设定簿 / 章节（应用前确认）
- **导入 / 导出**：TXT 导入（UTF-8 / UTF-16 / GBK 自动识别 + 预览确认）；TXT 导出；整书 JSON 备份 / 恢复
- **体验细节**：分类多标签筛选、Markdown 表格预览、全局 AI 进度条（可停止）、API Key 安全存储（Android Keystore）

## 🛠 技术栈

- **前端**：React 18 + Vite 5
- **跨端**：Capacitor 8（Android / Web）
- **AI**：DeepSeek API（`deepseek-v4-flash`，流式输出，可选思考模式）

## 🚀 本地运行

```bash
cd client
npm install
npm run dev      # Web 开发（localhost:5173）
npm run build    # 构建 Web 资源
```

## 📱 打包 Android

```bash
cd client
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
# 产物：client/android/app/build/outputs/apk/debug/app-debug.apk
```

也可以直接下载 [releases/moibi-debug.apk](./releases/moibi-debug.apk) 安装到手机（Debug 构建，约 4.4 MB）。

## ⚙️ 配置

首次使用需在 App 内填入 DeepSeek API Key（右下角 🖌 按钮）。Key 仅保存在本机：Android 上存于 Keystore 加密存储，Web 端存于 localStorage。

## 📁 结构

```
moibi/
├── client/
│   ├── src/
│   │   ├── pages/        # HomePage（书架） / ProjectPage（工作区）
│   │   ├── components/   # AiStatusBar / ConfirmDialog / KeySettings / ErrorBoundary
│   │   ├── services/     # deepseek / store / parser / discussPatches / backup / drafts / aiBusy / exporter
│   │   └── utils/api.js  # 统一业务入口
│   ├── android/          # Capacitor Android 工程
│   └── package.json
└── releases/             # 可安装的 APK
```

## 📝 说明

- 数据存储于设备本地（localStorage），卸载应用会清空；建议定期用书卡右上角 ⬇ 导出 JSON 备份。
- 本项目为个人创作辅助工具，仅供学习交流。
