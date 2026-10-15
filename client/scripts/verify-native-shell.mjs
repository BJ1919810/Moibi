/**
 * 仿真 Android 原生壳的**忠实时序**（与真机一致，这是关键）。
 *
 * 真机上的注入顺序（读 Capacitor 源码得出）：
 *   ① `androidBridge` —— WebView 建好时就 `addJavascriptInterface` 注入，**最早**。
 *   ② `native-bridge.js` —— 页面加载时由原生注入并执行，它把 win.Capacitor 建起来。
 *   ③ `PluginHeaders` + 各插件的桥接函数 —— **之后**由 JSExport 通过
 *      evaluateJavascript 注入（`window.Capacitor.PluginHeaders = [...]`）。
 *   ④ 前端 bundle（type=module，延迟执行）里 `registerPlugin('App')` 读 ③ 的结果。
 *
 * ⚠️ 上一版把 ③ 放在 ② 之前，虽然对象最终还在，但**与真机顺序不符**，
 *    导致 registerPlugin 拿到的 pluginHeader 状态不对、被判定成"未实现"。
 *    这正是这个仿真一开始误报的原因——**先修仿真，再谈产品代码**。
 */
export const HARNESS_PRE = `
<script>
(function () {
  // ① 原生对象（最早，等价 addJavascriptInterface）
  window.__nativeLog = [];
  window.__exitCalled = 0;
  window.__backListeners = [];
  window.__errors = [];
  window.addEventListener('error', e => window.__errors.push(String(e.message)));

  window.androidBridge = {
    postMessage(msg) {
      let m; try { m = JSON.parse(msg) } catch { return }
      window.__nativeLog.push(m);
      if (m.pluginId !== 'App') return;
      const cbId = m.callbackId;
      const method = m.methodName;
      if (method === 'addListener') {
        // 等价 Plugin.addEventListener：call.setKeepAlive(true) + 存起来
        window.__backListeners.push({ eventName: (m.options || {}).eventName, callbackId: cbId });
        window.Capacitor.fromNative({ callbackId: cbId, success: true, pluginId: 'App' });
      } else if (method === 'exitApp') {
        window.__exitCalled++;
        window.Capacitor.fromNative({ callbackId: cbId, success: true, pluginId: 'App' });
      } else if (method === 'removeListener') {
        // 忽略
      }
    },
  };

  // 「按下硬件返回键」——等价 AppPlugin.handleOnBackPressed（AppPlugin.java 47-62）
  window.__pressHardwareBack = function () {
    if (window.__backListeners.length === 0) {
      // 无监听者 ⇒ 原生走 bridge.getWebView().goBack()；WebView 无历史即退出应用
      return 'no-listener';
    }
    for (const l of window.__backListeners) {
      if (l.eventName !== 'backButton') continue;
      // notifyListeners('backButton', {canGoBack}) —— 事件经 fromNative 派发
      window.Capacitor.fromNative({
        callbackId: l.callbackId,
        success: true,
        pluginId: 'App',
        __emitEvent: { eventName: 'backButton', data: { canGoBack: false } },
      });
    }
    return 'delivered';
  };
})();
</script>
<script src="./native-bridge.js"></script>
`

/**
 * ③ 原生后注入的插件声明（等价 JSExport.generatePluginJS）。
 * `addListener` / `removeListener` 来自 Plugin 基类，rtype = 'none'（RETURN_NONE），
 * 所以走 nativeCallback 分支 —— 这点照 Plugin.java:731/743 与 PluginMethod 常量还原。
 */
export const HARNESS_POST = `
<script>
(function () {
  const cap = (window.Capacitor = window.Capacitor || {});
  cap.PluginHeaders = [
    { name: 'App', methods: [
      { name: 'addListener', rtype: 'none' },
      { name: 'removeListener', rtype: 'none' },
      { name: 'exitApp', rtype: 'promise' },
      { name: 'getInfo', rtype: 'promise' },
      { name: 'getState', rtype: 'promise' },
      { name: 'minimizeApp', rtype: 'promise' },
      { name: 'toggleBackButtonHandler', rtype: 'promise' },
    ]},
  ];
  // JSExport 还会生成每个插件方法的桥接函数（addListener 由 bridge 提供）
  cap.Plugins = cap.Plugins || {};
  cap.Plugins.App = cap.Plugins.App || {};
  cap.Plugins.App.addListener = function (eventName, callback) {
    return cap.addListener('App', eventName, callback);
  };
})();
</script>
`
