/**
 * 一次生成任务（run）的状态词汇 —— **唯一来源**，而且**按问题命名**。
 *
 * ⛔ 这套词原来在四个地方各写了一份（`workflow.js`、`replan.js`、`Write.jsx` 的 `ACTIVE`、
 *    以及 `Write.jsx` 里一个内联数组）。但逐条核对后发现：**它们回答的其实是三个不同的问题**，
 *    只是都被叫成了 `ACTIVE` / `BLOCKING`：
 *
 *      1. 机器**还在自己往前走**吗？           → RUNNING   （界面据此决定要不要继续轮询）
 *      2. 现在**能不能再起一个新任务**？        → BLOCKING  （服务端并发互斥）
 *      3. 这个任务**要不要接手显示给用户**？    → ATTENTION （界面用它找回「继续/确认/取消」的入口）
 *
 *    差别就在 `needs_input` 与 `awaiting_acceptance` 这两个「机器停了但在等人」的状态上：
 *      · 起新任务：**不该**被它们挡住 —— `createRun` 对它们是「接管」而不是「被拒」
 *        （确定性 run id ⇒ 同一个 run 直接返回，手里那份已付费草稿不会丢）。
 *      · 接手显示：**必须**包含它们 —— 否则用户在界面上再也回不到「继续」那个入口。
 *    两边数值不同不是漂移，**同名才是病**。所以这里按问题命名，并写清各自为什么。
 *
 * 为什么单独一个文件而不是塞进 `schema.js`：`schema.js` import 了 `node:crypto`，
 * 而前端组件要用这里的常量；零依赖才能让浏览器直接 import，不必为此把 crypto shim 拉进网页版 bundle。
 */

/** ① 机器仍在自行推进（界面据此继续轮询；停了就该停轮询，别空转） */
export const RUNNING_RUN_STATUSES = ['queued', 'planning', 'writing', 'extracting', 'reviewing']

/**
 * ② 占用作品、不允许再起新任务。
 *    在 RUNNING 之外多一个 `awaiting_acceptance`：机器停了，但**手里握着已付费的草稿**，
 *    正路是 `accept()` 提交它；此时再起一章会把它挤掉。
 *    ⚠️ **不含 `needs_input`**：那个状态正是「该重新起一次」的情形，`createRun` 会接管同一个 run。
 */
export const BLOCKING_RUN_STATUSES = [...RUNNING_RUN_STATUSES, 'awaiting_acceptance']

/** ③ 界面应当接手显示的任务（含两个「机器停了、等人处理」的状态） */
export const ATTENTION_RUN_STATUSES = [...BLOCKING_RUN_STATUSES, 'needs_input']

/** 已经结束、不会再变的状态 */
export const TERMINAL_RUN_STATUSES = ['committed', 'cancelled', 'failed', 'stale']

/**
 * ④ 允许 `resume()` 的状态（章节 run）。
 *    含 `failed` 与 `reviewing`：崩溃/失败后可以接着跑，手里那份草稿仍在。
 */
export const RESUMABLE_RUN_STATUSES = ['needs_input', 'failed', 'queued', 'reviewing', 'planning']

/**
 * ④' 允许 `resume()` 的状态（**重排** run）—— 与上面**故意不同**：
 *     重排没有 `failed` 这一档恢复语义（失败的全局重排要重新发起，避免拿着半份规划继续改），
 *     所以这里不含 `failed`。⛔ 别为了「统一」把两者合并 —— 那会改变恢复行为。
 */
export const RESUMABLE_REPLAN_STATUSES = ['needs_input', 'queued', 'planning']

/**
 * ⑤ 重排任务**还在跑**的状态（界面据此决定禁用按钮与继续轮询）。
 *    重排的状态机只有 queued → planning → writing → committed，没有 extracting/reviewing。
 */
export const RUNNING_REPLAN_STATUSES = ['queued', 'planning', 'writing']

export const isRunningRun = (run) => !!run && RUNNING_RUN_STATUSES.includes(run.status)
export const isBlockingRun = (run) => !!run && BLOCKING_RUN_STATUSES.includes(run.status)
export const isAttentionRun = (run) => !!run && ATTENTION_RUN_STATUSES.includes(run.status)
export const isTerminalRun = (run) => !!run && TERMINAL_RUN_STATUSES.includes(run.status)

/** 该作品当前占用的那个任务（没有则 null）。**并发互斥的唯一判据**。 */
export const findBlockingRun = (runs) => (runs || []).find(isBlockingRun) || null
