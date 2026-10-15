# 墨笔 · AI 小说创作坊（v2）

一句话灵感，自动成书。手机优先的水墨风写作应用：写下念头 → 墨笔铺开全书大纲 → 你点头，然后一章一章写下去。

> **文档状态（2026-10-13 核对）**：本文档主体写于 v2.0 交付期，目录树、测试数与「下一步」已按现状更新。
> 但**运行状态的权威来源是 `.workbuddy/memory/MEMORY.md`**（当前进度与最新踩坑）、细节在 `.skills/*.md`。
> 与外部 GPT 的评审往返文档统一在项目根目录 `GPT往来/`，**它们全部止于 2026-10-11 23:19，其中的「已落地」结论需回代码复核**。
> 另外两形态：① 网页/局域网（本文主要描述）② **独立离线 APK**（`npm run apk:release`，见 §十）。

---

## 一、三步跑起来

1. **双击 `启动墨笔.bat`**（会自动打开浏览器）
2. 进「设置」→ 选一个服务商预设 → 粘贴你的 API Key → 保存 → 测试连接
3. 回到书架 → 「写一个新的故事」→ 输入一句话灵感 → 交给墨笔

**在手机上用**：手机连同一个 WiFi，打开启动窗口里打印的那行「手机」地址即可。
（`localhost` 只能在电脑上用；手机上必须用 IP。）

> 关闭那个黑色窗口 = 停止服务。

---

## 二、首次配置密钥

设置页内置了四家预设，点一下自动填好接口地址与模型名：

| 服务商 | 接口地址 | 默认模型 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |

**密钥安全**：只写入本机 `data/config.json`，由后端持有。前端界面永远读不到明文，手机端也拿不到。

### 关于「深度思考」

新版模型（`deepseek-flash` 等）默认会先推理再落笔，思考内容走 `reasoning_content` 通道，**同样按输出 token 计费**。逐章写几百章会让成本明显上升，因此：

- **大纲生成**：跟随配置中的深度思考开关，默认关闭；不再强制消耗 reasoning token。
- **正文生成**：跟随配置中的深度思考开关，默认关闭；空正文最多自动关思考重试一次，仍为空则停止提交并提示人工处理。
- **记忆提取**：固定关闭
- 遇到不认 `thinking` 参数的供应商（通义 / Kimi / 智谱等），适配层会**自动忽略该参数并重试**，不会被卡住

> 注意：`thinking` 关闭只是省成本，不影响正文可用性。若发现文风单调，可以试着打开它写一两章对比。

---

## 三、目录结构

```text
mobi/
├── index.html                 前端入口
├── vite.config.js             构建配置（base 用相对路径，便于任意路径部署）
├── .npmrc                     npm 走国内镜像
├── 启动墨笔.bat                一键启动（自动构建 + 起服务 + 开浏览器）
│
├── server/                    后端（零运行时依赖，只用 Node 内置模块）
│   ├── index.js               HTTP 服务与静态托管（只做「读 HTTP → 调路由 → 写响应」）
│   ├── api-router.js          传输无关路由层：网页走 HTTP、APK 内直接函数调用，业务逻辑只一份
│   ├── auth.js                访问控制：本机免检 / 局域网口令 / 同源（Origin×Host）校验
│   ├── store.js               仓储层：项目、配置与任务持久化（JSON 文件；已抽象，可换 SQLite）
│   ├── schema.js              数据 Schema v2：实体 ID、账本工厂、三个 ID（记录/事件/幂等）、TRUST、校验
│   ├── ledger.js              账本读写 + selectContext 筛选（可信度 / 时间 / 相关性三重过滤）
│   ├── state-engine.js        R2 状态转移引擎：纯规划 + 原子提交 + 收尾 + 事件日志 + 按章回查
│   ├── projection.js          WriterPacket：送往正文模型的唯一出口 + findLeaks 生成前门禁
│   ├── foreshadow.js          R3 伏笔生命周期与披露事件（埋 / 回收 / 出处）
│   ├── workflow.js            R4 章节任务：规划 → 草稿隔离 → 审核门禁 → 提交 / 确认 / 取消 / 恢复
│   ├── recovery.js            R4 不确定请求的恢复策略（不盲目重发）
│   ├── context-compiler.js    R5 受控上下文编译：预算、必选项与 Manifest
│   ├── dynamic-plan.js        R5 低权限 L2 临时细化
│   ├── chapter-planner.js     L0 章节确定性轻量规划 + 风险判定（揭示秘密 / 回收伏笔 → 高风险）
│   ├── replan.js              L0 仅未来章节分批重排（mode: full / window，两者互斥）
│   ├── author-control.js      L0 偏好、改名、篇幅调整
│   ├── change-request.js      用户修改的唯一写入路径（Draft → ChangeRequest → 确认 → CAS 提交）
│   ├── change-impact.js       修改影响分析：按真实 cast / 伏笔 / 已定稿章节判定 risk 与受影响章节
│   ├── assistant.js           AI 助手：只提议不落库，用户确认后才走 ChangeRequest
│   ├── creative-options.js    创建页可选项（章节数 1–999、题材标签组等）与参数校验
│   ├── cost.js                成本与上限（金额熔断）
│   ├── migrate.js             v1 → v2 确定性迁移 + R1 幂等补丁 + R2 旧形状补事件 + R3 关联
│   ├── prompts.js             提示词层：L1 大纲 / L3 正文 / L5 提取 / 开书补全
│   ├── pipeline.js            生成流水线：大纲 → 逐章正文 → 记忆提取 → 导出
│   └── providers/
│       └── openai.js          ProviderAdapter：OpenAI 兼容协议，含重试与超时
│
├── tests/                     自动化测试（node:test，`npm test`）：现 24 个 *.test.js / 344 个顶层用例
│   ├── schema / ledger / migrate / projection / state-engine     数据、账本、迁移、投影、R2 引擎
│   ├── r1-guards / r3-foreshadow / replan / author-control       R1 安全、R3 伏笔、L0 重排与偏好
│   ├── next-system / change-flow / resume-guard / completion-regression   R4/R5 任务与修改闭环
│   ├── evidence-cn / summary-audit / p0-outline-thinking / backend-shim   中文证据、概要审查、思考预算、APK 后端
│   └── back-nav / page-not-drawer / create-autofill / direction-availability / v2-polish-round2 / new-creative
│       （测试必须带 `--import ./tests/_isolate.mjs`，见 `package.json`：它会重定向数据目录，避免覆盖真实密钥）
│
├── scripts/                   运维与验证脚本（`.wb-tmp` 易失，脚本一律留在这里并挂 `verify:*`）
│   ├── build-apk.mjs / export-txt.mjs            打包 APK；导出 txt/md/html（给番茄等平台）
│   ├── migrate-data.mjs / r3-upgrade.mjs         迁移 CLI（--dry-run）；R3 伏笔关联升级
│   ├── dump-writer-packet.mjs / dump-prompt.mjs  dump 真实 WriterPacket / 提示词
│   ├── measure-style.mjs / style-ab.mjs / style-ab-report.mjs / style-lockin.mjs   文风体检与 A/B 实验台
│   ├── fix-misplaced-payoffs.mjs                 修复历史数据里排期错位的 pay_off（默认 dry-run）
│   ├── verify-*.mjs                              back（原生壳仿真）/ back:web / autofill / nav / replan
│   └── chaos-full-book.mjs / live-stress.mjs     全量「胡闹」压测与真实压力测试驱动
│
├── docs/                      数据结构、分轮实施说明与样例
│   ├── data-schema-v2.md      数据 Schema v2 完整说明（含 R2 状态引擎与 R3 伏笔）
│   ├── R2_状态转移样例.md       R2 转移前后真实账本内容（脚本生成，非手写）
│   ├── R3_实施与验收.md         R3 实施与验收记录（⚠️ 第四节已被 R4/R5 超越，见文首提示）
│   ├── 全量推进_实施与验收.md    R4 + R5 + L0 全量推进的实施与验收记录
│   ├── 用户修改闭环_修复验收.md 用户控制闭环的权威实现与验收说明
│   ├── 用户控制闭环最终设计.md / ChangeRequest_用户修改链路_旧稿.md   历史设计草案（勿当现状）
│   └── writer-packet-*.md / 试写样例_第1-2章.md  投影样例（三套格式并存，注意口径差异）
│
├── src/                       前端源码（React 18 + Vite，唯一一套前端）
│   ├── App.jsx                路由（页面栈）与全局状态
│   ├── lib/api.js             唯一后端通道（网页走 fetch，APK 走本地懒加载）
│   ├── lib/back-nav.js        返回键优先级纯函数：浮层 → 页面栈 → 系统
│   ├── lib/native-shell.js    原生壳判定（androidBridge → isNativePlatform → platform）
│   ├── lib/reader-prefs.js    阅读偏好（只存本机 localStorage，键 mobi_reader_prefs）
│   ├── backend/               APK 本地模式：app.js + runtime.js + shims/{crypto,fs,path,os,url}
│   ├── components/            CreationDrawer / ExportSheet / NavDrawer / ReaderSettings / AssistantBox / ChapterList
│   ├── screens/               Shelf / Create / Outline / Write / Reader / Settings / Direction / Assistant
│   └── styles/
│       ├── tokens.css         水墨设计 token（继承 v1）
│       └── app.css            界面样式
│
├── public/                    manifest.webmanifest、icon.svg
├── data/                      运行时数据（自动生成，含 config.json 与 runs/、changes/）
├── dist/                      前端构建产物（React，由 `npm run build` 生成）
├── outputs/                   导出成品（md/txt/html）与打包出的 APK
├── android/                   Capacitor 壳（APK 用）
└── .backups/                  迁移与合并前的自动备份
```

**前端只有一套**：React 18 + Vite。`dist/` 就是它的构建产物（`assets/index-*.js` + `assets/index-*.css`），由 Node 服务直接托管；不存在第二套手写前端。改了 `src/` 之后需要重新 `npm run build`。

---

## 四、对照《AI小说生成器工程规划》的实现情况

主人要求「以工程规划文档为主」，因此**结构与分层严格照做**；初版收窄的规模，已按 R3 → R4 → R5 → L0 逐轮补齐。

### 已实现

| 文档 | 内容 | 落地位置 |
|---|---|---|
| §2 | 素材库与事实库分离 | 实体表 `entities[]` + 账本 `ledger`（canonicalFacts / currentState / characterKnowledge / plotThreads / **stateEvents**） |
| §3 L1 | 全书／卷规划 | `pipeline.generateOutline` + `prompts.outlineMessages`（章节数由 `targetChapters` 参数化） |
| §3 L2 | 章节目标可验收 | 大纲每章强制给出 `goal`；运行时由 `dynamic-plan.js` / `chapter-planner.js` 做低权限细化（R5/L0） |
| §3 L3 | 正文写作 | `workflow.js`（活路径），消息体一律经 `projection.buildWriterPacket` 投影 |
| §3 L5 | 记忆提取与提交 | `prompts.extractMessages` + `ledger.applyExtraction`，只记正文明确写出的内容，带稳定 ID 与出处章节 |
| §4 | 可见性与披露策略 | 角色字段白名单 + 章节出场白名单 + 伏笔 seed/payoff 隔离由 `projection.js` 强制；`foreshadow.js` 管伏笔生命周期与披露事件（R3）；`findLeaks` 作为生成前门禁 |
| §6 | 上下文编译器 | `context-compiler.js` 按预算编译、标明必选项并产出 Manifest；`projection.js` 是送往正文模型的**唯一出口**；`ledger.selectContext` 按「可信度 × 时间边界 × 相关性」三重过滤，各自限长且报告剔除理由（R5） |
| §8 | 任务状态机与断点恢复 | `workflow.js` 持久化章节任务（规划 → 编写 → 审核 → 提取 → 提交／待确认）；关掉页面服务端继续跑，重开可查进度、草稿、Manifest、token 与失败原因；`recovery.js` 对「不确定是否已送达」的请求不盲目重发（R4） |
| §9.4 | 原子提交 | `store.writeJSON` 先写临时文件再 rename；账本层 `state-engine.commitStatePlan` 先构造后一次性写回，非法转移整批不落；章级用 `headVersion` + `editRevision` CAS |
| §10 | 改前文的失效传播 | 不做自动传播，改为「目标章节数变化 → 标记待重排 → 只重排未来章节」（`replan.js`），已确认的章节与正文保留（L0） |
| §11 | 成本核算 | 每次调用累计 `usage`（次数／输入／输出 token），书架卡片可见；设置单价后可按金额熔断（`cost.js`，付费调用前检查） |
| §12 | 模块化单体 | `server/` 按 store / schema / ledger / state-engine / projection / foreshadow / workflow / context-compiler / prompts / pipeline / providers 分层 |
| §14 | 提示与输出契约 | `prompts.js`，正文走纯文本通道，结构化输出走 JSON 通道 |
| §15 | 测试与质量评估 | `tests/`，`npm test` 共 **344 个顶层用例（24 个测试文件）**；含确定性泄漏门禁（`findLeaks`）、R1 验收用例、R2 状态引擎与三个必测场景、R3 伏笔、R4 草稿隔离／版本冲突／幂等／取消竞态、L0 偏好与重排、中文证据、APK 后端等价性 |

### 仍未做

| 文档 | 为何暂缓 |
|---|---|
| §3 L4 审核与局部修订（ReviewReport） | **未完整实现**：现有为 `workflow` 门禁 + `risk` 判定，没有独立的审核/修订层 |
| §5 SQLite 与完整版本表 | 目前用 JSON 文件；`store.js` 已按仓储抽象，替换不牵动调用方 |
| §8 的多进程 / 分布式 exactly-once | 单机 JSON 仓储适合单人使用；提供进程内串行保护与版本比较，不声称分布式语义 |
| SSE 流式输出 | 未做，等待期用 loading 承载 |

---

## 五、常用命令

```bash
npm run server          # 只启动后端（端口 8787）
npm run build           # 构建「网页版」前端到 dist/
npm run dev             # Vite 开发模式（热更新，自动代理 /api 到 8787）
npm test                # 24 个测试文件 / 344 个用例（已自动隔离数据目录）
npm run apk:release     # build:app → cap sync → 打签名 APK（产物在 outputs/）
npm run verify:nav      # UI 验证：创书页必填三态 + 导航截图（需 msedge）
npm run verify:back     # 原生壳返回键仿真 11 条用例（需先 build:app）
npm run verify:reveal   # 伏笔回收授权：对真实作品做只读演练（绝不写 data/）
npm run verify:reveal:ui # 同上的真 UI 验证：隔离数据目录 + 真 Edge，15 条断言
npm run verify:autofill / verify:replan / verify:replan:real
```

> 开发时请**同时**开 `npm run server` 和 `npm run dev`。
> ⚠️ 用 `dist` 截图验证前先确认构建模式：`build:app` 是 `LOCAL_MODE`（读 localStorage、不发 HTTP），截图会是空书架。

---

## 六、导出作品：格式与内容自选

书内页（大纲页／执笔页／阅读页）底部的「导出」按钮会打开导出面板，两步可选：

**① 文件格式**

| 格式 | 说明 |
|---|---|
| **Markdown**（默认） | 保留 `#` 层级，便于再排版、贴进其它编辑器 |
| **纯文本** | 纯文字，随处分发；不含任何标记符号 |

**② 导出内容**（可多选，**书名**与**正文**为默认勾选项）

`书名` · `简介与主题` · `大纲`（三幕结构／分卷目标／分章梗概） · `人物设定` · `伏笔清单` · `正文` · `统计信息`

实现上，导出先构造与格式无关的**节点中间表示**（`buildExportNodes`），再由 `renderDocument(nodes, format)` 分别渲染 md / txt —— 因此纯文本导出**不会漏出 `**加粗**` 之类的 Markdown 语法**；纯文本的标题下划线按 CJK 宽度（汉字算 2 列）计算，对齐正确。

对应接口：

- `GET /api/export-options` → 返回可用格式与内容项（含 `isDefault`），前端面板以此为单一数据源（后端不可达时回退到内置常量）。
- `GET /api/projects/:id/export?format=md|txt&parts=title,body,...` → 返回带 `Content-Disposition` 的文件流；文件名做 URL 编码（`filename=` + `filename*=UTF-8''`），中文书名不乱码。`parts` 省略或为空时回到默认项（书名 + 正文）。
- `pipeline.exportMarkdown(project)` 作为旧签名兼容包装保留，内部即 `exportDocument(project, {format:'md', parts:['title','body']}).body`。

**给外部平台投稿**用 `node scripts/export-txt.mjs --project p_xxx [--from 1 --to 10 --name 书名]`，一次产出 `<书名>.txt`（番茄等平台友好）/ `.md` / `.html`（便于直接浏览器阅读）到 `outputs/`。

---

## 七、访问控制与数据安全

墨笔服务同时托管前端与 API（同源），因此安全模型分两层：

1. **局域网口令**：运行服务的本机免口令；同一 WiFi 下的其他设备必须携带启动时打印的口令（`X-Mobi-Token` 头，或导出链接的 `?t=` 参数）。启动窗口会直接打印带口令的手机地址。
2. **同源校验**：服务端**不返回任何 `Access-Control-Allow-*` 头**，并对每个 `/api/*` 请求校验 `Origin` 与 `Host` 是否一致 —— 跨源请求（含 `file://` 的 `null` 源）返回 **403**。

> 为什么两层都要：只免口令、又开全开放 CORS 时，本机浏览器里的任意网站都能跨源打到 `127.0.0.1`，利用「本机免检」读作品、触发付费生成。移除通配 CORS + 同源校验后这条路径被堵死。

其他边界：

- **密钥只在后端**：`data/config.json` 由后端持有，前端永远读不到明文。
- **记忆隔离**：账本条目带 `trust` 标记，只有 `canonical`（有可信来源）的条目能进入正文上下文；旧数据迁移来的「无出处」记录留在存储层但被隔离，并在章节 `contextNotes` 中说明。
- **时间边界**：早于当前章的记录不会泄漏进本章正文（`ledger.isVisibleAt`）。
- **状态唯一**：同一 `(主体, 属性)` 或 `(角色, 事实)` 在任一时刻只有一条 `active` 记录，旧记录收尾留档但不进上下文 —— 不会同时看到「他怀疑」和「他确信」。
- **用户是唯一有权改作品的人**：所有作者侧修改走 ChangeRequest（`POST /api/projects/:id/changes` → `/approve`），旧的直写接口 `/author-settings` 已废弃（HTTP 410）。AI 助手只提议、不落库。

安全与确定性改造的说明见 **`GPT往来/墨笔v2_R1改造说明_对应第2轮评审.md`**（与外部评审往返的文档统一归档在项目根目录的 `GPT往来/`）；R2 状态转移改造见 **`GPT往来/墨笔v2_R2改造说明_对应第2轮评审.md`**；数据字段定义见 `docs/data-schema-v2.md`；转移前后真实数据见 `docs/R2_状态转移样例.md`。

---

## 八、已知限制

- **正文生成已是持久化任务（R4）**。关掉页面后服务端会继续跑完并落盘；重开页面可查看任务进度、草稿、输入 Manifest、实际 token 和失败原因。但**「不确定是否已经送达」的外部 API 请求不会在重启后自动重发**（避免重复扣费）——不确定时由你自己决定是否重试；重试抽取可以复用已完成的正文。
- **高风险章节会停下来等你确认**。揭示秘密或回收伏笔的章节标记为高风险，停在「待确认」，你点头后才写入正式记忆；普通章节自动提交。正文被截断、状态矛盾、抽取失败或基线过期时，正式记忆不推进。
- **伏笔回收需要作者授权**（已可操作）。「创作资料与编辑 → 伏笔 → 修改内容 = 回收披露授权」：
  填一段「可以对读者说出的版本」并提交即完成授权，清空后提交＝撤回。
  正文里只会出现这段授权文本；**作者侧的原始回收真相（`payoff`）永不进正文**。
  授权只放宽「谁批准了」，不受后续重排影响，也绕不过客观门禁：
  - 回收章与伏笔声明不符（排期错位）⇒ 先跑 `node scripts/fix-misplaced-payoffs.mjs --project <id> [--apply]`；
  - 该伏笔还没有已确认的铺设、或关联仍待审核 ⇒ 先补齐这些，再授权。
  用 `npm run verify:reveal` 可对任何作品只读演练「授权前拦 / 授权后放行」。
- **三个「作者批准」入口**（都在「创作资料与编辑」里，走同一套「预览影响 → 确认提交」）：
  | 做什么 | 在哪 | 为什么需要它 |
  |---|---|---|
  | **伏笔关联章号** | 伏笔 → 伏笔关联章号（埋/收） | 迁移来的旧作品伏笔是「待审核」且章号为空，模型一旦把回收排到某章，那章会被**永久拦住** |
  | **批准本章写作任务** | **执笔页**（会先把「将要交给正文模型的内容」摊开给你看，再让你点头） | 不批准时每章会**额外调用一次 L2 模型**现编安全任务，而作者付过钱的 `writerSummary` 永远不会进正文 |
  | **角色秘密披露授权** | 角色卡 → 披露授权（秘密→读者） | 不授权时「角色秘密可控披露」整块不可达：作者能写 `secret`，却没有任何办法允许它出现在正文里 |
  三者的共同纪律：**模型无权自我批准**（`pay_off` 一律 `approved:false`、`writerTaskApproval` 一律 `proposed`、披露必须显式授权），批准只能由上面这些作者动作写入。
- **手机浏览器无法「添加到主屏幕」**。PWA 安装要求 HTTPS，目前是 `http://内网IP`。要装到桌面需配 HTTPS（或走内网穿透），**或直接用独立离线 APK**（见 §十）。
- **一章一次成文**，未做多场景拆分。长章（3000 字以上）可能被输出上限截断。
- **大纲与正文都依赖模型质量**。若模型返回的 JSON 不合规，会自动重试一次；仍失败会给你明确的错误提示。
- 数据存在 `mobi/data/`，**直接复制这个目录即可备份**（APK 形态的数据在手机 localStorage 内，卸载即清空，请用「一键导出」）。

---

## 九、当前状态与下一步（按优先级）

已完成：**R2 状态转移 → R3 伏笔关联与权限投影 → R4 可靠提交（草稿隔离／审核门禁／幂等／恢复）→ R5 动态编译器与轻量 L2 → L0 创作偏好／改名／篇幅／重排 → 独立离线 APK → 用户控制闭环（ChangeRequest + 影响分析 + CAS）→ 文风控制（单变量 A/B 定位并撤掉短句干扰信号）**。

真实付费长程评测已跑过三轮（累计约 ¥0.5）：

| 作品 | 进度 | 备注 |
|---|---|---|
| 《樱池旧部志》 | 25/30 章 / 70447 字 | 含改设定、全局重排、10 条胡来用例；第 26–30 章被伏笔授权门禁拦下 |
| 《风起处见线》 | 17/30 章 / 44955 字 | 含 4 次改设定；验证了 pay_off 排期错位的修复 |
| 《北行第七日》 | 5/30 章 / 12818 字 | 文风改动后的新书；第 6 章需先在目录「细化下一组」 |

下一步：

1. ~~决定伏笔回收的批准入口~~ —— **已落地**（2026-10-13）：创作资料与编辑 → 伏笔 → 「回收披露授权」，
   填文本=授权 / 清空=撤回；`reviewedBy`/`approved` 由服务端写。只读演练：`npm run verify:reveal`。
   剩下的只是一个**动作**：对《樱池旧部志》清一次历史排期错位 ——
   `node scripts/fix-misplaced-payoffs.mjs --project p_737e9cf5455f --apply`（dry-run 已确认仅 3 条，写前自动备份）。
2. **线索只增不减**：`extracted.resolved` 的模型产出率为 0（要求字符串精确匹配），建议改成「按 ID 勾选」或在提交时做确定性去重。
3. **文风**：已撤掉「紧张处缩短句子」等两处干扰信号；但需在同一本书上做「改前/改后」对照，才能确认句长改善可推广（新书的句长统计尚未复现预期）。
4. **SSE 流式输出** / **迁移 SQLite** —— 体验与规模问题。
5. **HTTPS** —— 网页版「添加到主屏幕」的前提（APK 已绕开）。

---

## 十、独立离线 APK（Capacitor）

```bash
npm run apk:release     # = build:app → cap sync → scripts/build-apk.mjs release
```
产物：`outputs/墨笔_v<版本>-<变体>-<日期>.apk`（release ≈ 3 MB，已签名）。

做法是**把 `server/` 整包编进前端 bundle**（四个 shim 替掉 `node:crypto/fs/path/os/url`），前端直接函数调用，不联网、不依赖电脑。关键坑：虚拟根必须恒定（否则升级后 localStorage 键前缀变化 = 作品「全没了」）、返回键必须用 `@capacitor/app` 订阅（Capacitor 核心不接管）。详细踩坑见 `.skills/apk-打包.md`。

---

## 十一、2026-10-11 创作体验改造（A1–B5）

本次修改仅以当前 v2 工程为基线，不把 v1 原生壳或全量上下文拼接方案引回正文链路。

- **A1 篇幅**：创建页 1–999 章连续滑条，默认 30。由 L1 先输出开篇详细规划，更远章节标记 `pendingDetail`，待逐章 L2 细化，不把 999 章全部塞给一次模型请求。
  （⚠️ 2026-10-11 晚已把开篇窗口从「首 24 章」收紧为 **`OUTLINE_WINDOW = 5`**：只细化开篇 3–5 章，其余靠目录里的「细化下一组」，见下一节。）
- **A2 文风**：创建时写入 `preferences.style`，大纲页可查看并编辑；`outline.style` 是模型建议，用户明确偏好优先。旧项目缺字段也能打开。
- **A3 助手**：`assistant.js` 使用独立 run 的 `proposed → accepted/rejected/stale` 状态；必须由用户确认才走版本比较提交。没有正文改写与安全策略写入能力。（后续统一并入 ChangeRequest 通道。）
- **B1 人物卡**：新增 `entities[].characterCard` 作者侧拓展字段；`projection.js` 未改，正文仍只接收角色公开身份及安全字段。
- **B2 多题材**：新作品使用 `genreTags` 数组保存标签，`genre` 保留主背景兼容旧单字符串；规划提示将背景、机制、衍生、基调分别传递。
- **B3 PWA**：v1 图标笔划作为金色小装饰，主图继续使用 v2 朱砂“墨”字；提供常规和 maskable PNG、apple-touch-icon、manifest 与不缓存 `/api` 的 Service Worker。
- **B4 目录**：沿用现有「按卷分条 + 已写章节跳转」只读目录；不引入直接增删章节的第二条写入路径。
- **B5 提示词**：作者侧规划可以利用完整角色卡，正文只走 `projection.js` 与 `findLeaks()`，没有回到 v1 全量拼接。

**构建环境说明（历史）：** 该次交付的运行环境无法连接 npm 仓库，包内 `dist/` 是离线预览产物。正式 `dist/` 请在具备 npm 环境的机器上执行 `npm install --ignore-scripts && npm run build`。

---

## 十二、P1 与用户控制流收尾（2026-10-11）

- 新建大纲保留用户目标章节数，先规划开篇约 3～5 章（`OUTLINE_WINDOW = 5`），其余标记 `pendingDetail`。L1 的三幕和分卷里程碑保留全书尺度；进入占位章节之前需在目录使用「细化下一组（最多 5 章）」进行高权限安全规划，后续单章 L2 再生成可见写作指令。
- 不要求模型一次恰好返回 5/24/30 章（门禁为**容差**：`minimum = min(target, max(1, window-2))`）；缺失必要角色或不足 3 章的 30 章开篇会明确失败。失败作品存为 `outline_failed`，可在目录重试。
- 作者变更依次经 Draft → ChangeRequest → 影响分析 → 作者确认 → CAS；高风险变化锁定 `pendingReplan`，必须全局重排（`mode:'full'`）后解锁，滚动细化不能替代高风险重排。
- 正文连续为空时，已确认的空响应最多额外请求一次，关闭思考；run 记录每次可得 usage，并在两次都空时停为 `needs_input`。正常网络异常不会自动发第二次。
- 本交付不包含 API 密钥和用户项目数据；正式前端 `dist/` 必须由本机 `npm ci && npm run build` 产生。
