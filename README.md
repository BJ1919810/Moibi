# 墨笔 Moibi · AI 小说创作坊

一句话灵感 → 大纲 / 人设 / 伏笔 / 设定簿 / 章节续写 / 创作讨论，一站式完成长篇网文创作。

React 18 + Vite 5 + Capacitor 8，支持 **Web 与 Android（APK）**，AI 调用 DeepSeek API（SSE 流式，可选思考模式）。

## ✨ 功能

- **一句话灵感开书**：输入核心想法与分类（40 个标签，按题材 / 设定 / 文风分组），AI 推演完整小说设定
- **创作模块**：
  - **剧情大纲 · 两段式多方案**：先生成 3 个约 100 字的差异化走向供挑选，选定后再展开详尽大纲
  - **角色卡**：结构化角色（能力 / 身份 / 关系网 / 状态），AI 生成直出 JSON，续写后按【设定更新】自动同步；单卡可导入导出
  - **伏笔设计**：按揭示时机分组（远端 / 中端 / 近端），互相勾连
  - **设定簿 · 当下情报**：记录当前时间点的物品 / 关系 / 地点 / 未了结线索，随剧情更新；可 AI 整理压缩、从正文一键抽取（能力归角色卡管理）
  - **章节续写**：两轮对话（正文 + 随笔 → 设定更新），断点草稿可续，元话术自动重试
  - **高质量模式**：续写走「规划 → 草稿 → 批改」管线，规划与一致性批改过程实时可见
  - **章节后处理**：重写 / 扩写 / 润色 / 换风格，支持只处理选中片段
  - **创作讨论**：与 AI 导师对话，修改提议走函数调用（tools），渲染为卡片、确认后才落盘
- **导入 / 导出**：TXT 导入（UTF-8 / UTF-16 / GBK 自动识别 + 预览确认）；TXT 导出（Android 走系统分享）；整书 JSON 备份 / 恢复
- **体验细节**：分类多标签筛选、Markdown 表格预览、全局 AI 进度条（可停止）、API Key 本地安全存储（Android Keystore / Web localStorage）

## 🛠 技术栈

- **前端**：React 18 + Vite 5
- **跨端**：Capacitor 8（Android / Web）
- **AI**：DeepSeek API（SSE 流式，可选思考模式；讨论与角色卡使用函数调用 / JSON 结构化输出）

## 🚀 本地运行

```bash
cd client
npm install
npm run dev      # Web 开发（localhost:5173）
npm run build    # 构建 Web 资源
```

## 📦 打包 Android

```bash
cd client
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
# 产物：client/android/app/build/outputs/apk/debug/app-debug.apk
```

也可以直接下载 [v1.0.0 发行页](https://github.com/BJ1919810/Moibi/releases/tag/v1.0.0)（含 `moibi-v1.0.0-debug.apk`） 安装到手机（Debug 构建，约 4.2 MB）。

## ⚙️ 配置

首次使用需在 App 内填入 DeepSeek API Key（右下角 ⚙️ 按钮）。Key 仅保存在本机：Android 存于 Keystore 加密存储（不可用时自动回退本地存储），Web 端存于 localStorage。

## 📁 结构

```
moibi/
├── client/
│   ├── src/
│   │   ├── pages/        # HomePage（书架）/ ProjectPage（工作区）
│   │   ├── components/   # AiStatusBar / ConfirmDialog / KeySettings / ErrorBoundary / CharactersPanel / CharacterCardEditor
│   │   ├── services/     # deepseek（AI）/ store（数据）/ parser / characterCards / discussPatches / backup / drafts / aiBusy / exporter
│   │   └── utils/api.js  # 统一业务入口
│   ├── android/          # Capacitor Android 工程
│   └── package.json
└── releases/             # 安装包见 Releases 页
```

## 📌 说明

- 数据存储于设备本地（localStorage），卸载应用会清空；建议定期用书卡右上角 ⬇ 导出 JSON 备份。
- 本项目为个人创作辅助工具，仅供学习交流。

---

## 🆕 v2.0.0（当前版本）

这一版把项目从「纯前端 + 浏览器里调模型」升级成**带长期状态管理与剧情一致性控制的创作工作台**：

- **零第三方运行时依赖的自研后端**（`client/server/`，Node 原生）：同一份后端同时支撑
  **网页版（HTTP + fetch）** 与 **Android 离线版（后端直接编进 bundle，函数调用，无网络）**
- **硬护栏**：`projection.js` 是送正文模型的**唯一出口**；`findLeaks()` 是**生成前门禁**
  （秘密/身份/未授权揭示不得进提示词）；伏笔**只给 seed 不给 payoff**；cast 白名单；
  `risk==='high'` 或关闭自动提交时停在「待确认」
- **用户修改的唯一写入路径**是 ChangeRequest（持久化预览 → 影响分析 → 作者确认 → 带版本校验提交），
  任何编辑都不直接改作品
- **长期账本**：事实 / 状态 / 认知 / 线索四类，带出处与置信度，跨章一致
- **滚动规划**：只细化未来 5 章，边写边推演，改设定触发有界重排
- **概要审查**：自动标出「表层概要里混进了真相」的章节并排序（弱信号单独标注，不误伤）
- **阅读器**：上下滚动 / 左右翻页两种模式，点击分区翻页、进度条可拖动跳转

### 质量

- **453 项单测全绿**（`cd client && npm test`），含**源码扫描类防复发断言**
  （判据副本、野字段名、死代码复活都会被测试拦下）
- 真浏览器验收脚本：`npm run verify:reader`（29 项）、`npm run verify:reveal:ui`（47 项）
- **安装包**：[v2.0.0 发行页](https://github.com/BJ1919810/Moibi/releases/tag/v2.0.0)（含 `moibi-v2.0.0-release.apk`）
  （3104 KB，完全离线可用：模型调用直接从 App 发出，不需要电脑）
