/**
 * 返回键的**决策核心**（纯函数，无副作用）。
 *
 * 背景：墨笔有两种运行形态，返回键来源完全不同——
 *   · 桌面/局域网网页：浏览器返回键 ⇒ popstate 事件；
 *   · Android 原生壳（APK）：硬件返回键 ⇒ Capacitor `backButton` 事件。
 *
 * 两种形态**共用同一套优先级**，所以把决策抽在这里，由 App.jsx 调用。
 * 抽出来的另一个好处：可以脱离浏览器单测（见 tests/back-nav.test.js），
 * 避免再出现「在浏览器里测着像绑好了、装到手机上按一下直接退出」这种事。
 *
 * 优先级：浮层（越晚开的越先关）→ 页面栈 → 到顶交还系统。
 */

/** 浮层的关闭顺序：先关「后开」的（与视觉层级一致）。 */
export const OVERLAY_ORDER = ['export', 'nav']

/** 决策结果 */
export const BACK_PANEL = 'panel' // 关掉一个浮层，页面栈不动
export const BACK_NAVIGATED = 'navigated' // 退回上一层页面
export const BACK_EXIT = 'exit' // 已在最外层，交还系统（App 内 ⇒ 退出）
export const BACK_INCONSISTENT = 'inconsistent' // 浮层状态自相矛盾 ⇒ 走 backFallback

/**
 * 算出「这次返回该做什么」。
 *
 * @param {object} s
 * @param {Record<string, boolean>} [s.overlays] 各浮层是否开着
 * @param {string} [s.view] 当前视图（'read' 时多一层页面内的面板守卫）
 * @param {Array<string>} [s.stack] 页面栈（长度 >1 表示还能退）
 * @param {number} [s.stackDepth] 兼容旧调用：直接给栈深度
 * @returns {'panel'|'navigated'|'exit'}
 */
export function resolveBack({ overlays = {}, view, stack, stackDepth } = {}) {
  // ① 浮层优先：任何浮层开着，返回键先关它（不关页面）。
  //    ⚠️ 若以后又出现「A 浮层里开 B 浮层」这种叠加，必须把「谁开在谁上面」
  //    建模成栈；目前铺平了，所以「多个浮层同时为真」就说明状态是坏的，
  //    交给 backFallback 兜底。
  //
  //    AI 助手与创作资料曾经也在这里（各自是个 boolean 浮层），现已改成**整页**、
  //    进入页面栈 —— 所以浮层只剩「导出」和「作品导航」两个。
  //    这也是改造的收益：页面层级由 stack 统一决定，加一个入口不必再登记浮层。
  const open = OPENABLE_OVERLAYS.filter((name) => overlays[name])
  if (open.length > 1) return BACK_INCONSISTENT
  if (open.length === 1) return BACK_PANEL
  // ② 页面栈：还能退就退一层。
  const depth = Array.isArray(stack) ? stack.length : (stackDepth ?? 1)
  if (depth > 1) return BACK_NAVIGATED
  // ③ 到顶：交还系统。网页形态浏览器可能退出/后退到站外；
  //    原生壳由调用方决定（当前实现 = exitApp）。
  return BACK_EXIT
}

/**
 * 兜底决策（**只在真的出事时才被调用**）：状态不一致（多个浮层同时为真）
 * 或别的原因让精确关层做不到时，别一口气退一层页面或把用户顶出应用，
 * 而是把所有浮层收干净、页面原地不动。
 *
 * 背景（主人实测）：「创作资料」面板左上角 ☰ 点了没反应。
 * 根因是当时 ☰ 的 onClick 读了一个**组件没接收的 prop**（undefined），
 * 也就是说这个键从来没被正确接线过。除了修接线，这里再加一层护栏：
 * 以后再出现类似的「层数对不上」，最坏结果也只是关掉面板，而不是丢页面。
 *
 * @returns {'panel'}
 */
export function backFallback() {
  return BACK_PANEL
}

/** 可以「打开/关闭」的浮层。
 *  AI 助手与创作资料**不在**这里 —— 它们是整页（走 stack），不是浮层。 */
export const OPENABLE_OVERLAYS = ['nav', 'export']

/**
 * 阅读页内部的「第二级」守卫结果：设置 / 目录面板。
 * 独立成一个函数是因为它只在 view === 'read' 时才参与决策，
 * 且由 Reader 组件通过 ref 注册进来（见 App.jsx 的 readerGuardRef）。
 *
 * @param {{showSettings?: boolean, showToc?: boolean}} panels
 * @returns {boolean} true = 已消费（关掉了面板），返回键不该继续往下走
 */
export function resolveReaderPanel({ showSettings = false, showToc = false } = {}) {
  return Boolean(showSettings || showToc)
}
