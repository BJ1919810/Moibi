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

也可以直接下载 [releases/moibi-debug.apk](./releases/moibi-debug.apk) 安装到手机（Debug 构建，约 4.2 MB）。

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
└── releases/             # 可安装的 APK
```

## 📌 说明

- 数据存储于设备本地（localStorage），卸载应用会清空；建议定期用书卡右上角 ⬇ 导出 JSON 备份。
- 本项目为个人创作辅助工具，仅供学习交流。
