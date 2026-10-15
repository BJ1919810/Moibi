/**
 * 「AI 助手 / 创作资料与编辑」必须是**整页**，不是浮层抽屉（回归测试）。
 *
 * BUG 背景（主人实测两次）：
 *   第一次：「创作资料左上角目录图标点了没反应」—— 那是 ☰ 的 onClick 读了一个
 *          组件没接收的 prop（undefined）。当时我只是把 ☰ 修好，**容器没动**。
 *   第二次（主人原话）：
 *     「AI 助手顶部那里，取消 X 号，改为和其他的一样，最左边是目录 icon，
 *       然后紧贴着"AI 助手"四个大字，和其他的页面（比如"剧情方向修改"那一页）一样」
 *     「创作资料那里，你压根没想到过改容器样式改成和其他的一样的，还是浮窗的格式，
 *       而且依旧有 X 号 … 我点目录自动退出这个界面了」
 *
 * 根因：这两个入口做成了 side drawer（右侧滑入 + 面板头 + ✕），而「剧情方向修改」
 * 是正常页面。二者本是同一类东西（完整的作者操作入口），不该两种容器。
 * 而且浮窗里点 ☰ 只能「先关自己再开导航」⇒ 用户感觉就是「点目录把这一页关掉了」。
 *
 * 这个测试**读源码文本**锁住结构：这两个入口必须是页面栈里的 view，
 * 且组件里不能再出现浮层容器 / ✕ 关闭键。跑得比 UI e2e 快，做第一道防线；
 * 真行为由 scripts/verify-nav-direction.mjs 用真 Edge 端到端验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(resolve(here, '..', p), 'utf8')

const app = src('src/App.jsx')
const assistant = src('src/screens/Assistant.jsx')
const materials = src('src/components/CreationDrawer.jsx')
const navDrawer = src('src/components/NavDrawer.jsx')

/* ------------------------------ App 接线 ------------------------------ */

test('App 把 assistant / materials 作为页面栈里的 view 渲染', () => {
  for (const v of ['assistant', 'materials']) {
    assert.match(app, new RegExp(`view === '${v}'`), `App.jsx 缺少 view === '${v}' 的渲染分支`)
  }
})

test('App 不再持有这两个浮层的开关状态（已进页面栈）', () => {
  assert.doesNotMatch(app, /assistantOpen/, 'assistantOpen 应已删除（它现在由 stack 决定）')
  assert.doesNotMatch(app, /materialsOpen/, 'materialsOpen 应已删除（它现在由 stack 决定）')
})

test('App 不再 import 旧的 AssistantDrawer（已删文件）', () => {
  assert.doesNotMatch(app, /AssistantDrawer/)
})

test('顶栏标题表里有这两个页面的名字', () => {
  assert.match(app, /materials:\s*'创作资料与编辑'/)
  assert.match(app, /assistant:\s*'AI 助手'/)
})

test('它们在 inProject 列表里 ⇒ 顶栏会显示「☰ + 标题」（和剧情方向修改同构）', () => {
  const m = app.match(/const inProject = [^\n]+/)
  assert.ok(m, '找不到 inProject 定义')
  for (const v of ['direction', 'materials', 'assistant']) {
    assert.ok(m[0].includes(`'${v}'`), `inProject 里缺 '${v}'`)
  }
})

test('返回键的浮层集合里不该再出现这两个（它们走页面栈）', () => {
  const m = app.match(/const overlays = \{[^}]*\}/)
  assert.ok(m, '找不到 overlays 定义')
  assert.doesNotMatch(m[0], /materials/, 'materials 已是页面，不该继续登记为浮层')
  assert.doesNotMatch(m[0], /assistant/, 'assistant 已是页面，不该继续登记为浮层')
})

/* ------------------------------ 组件本身 ------------------------------ */

test('AI 助手是页面组件：没有浮层容器、没有 ✕', () => {
  assert.doesNotMatch(assistant, /drawer-mask/, 'AI 助手不该有浮层遮罩')
  assert.doesNotMatch(assistant, /drawer--wide/, 'AI 助手不该用抽屉容器')
  assert.doesNotMatch(assistant, /drawer__close/, 'AI 助手不该有 ✕ 关闭键')
  assert.doesNotMatch(assistant, /onClose/, 'AI 助手是页面，不该接收 onClose')
})

test('AI 助手用页面级贴底操作条（与剧情方向修改同构）', () => {
  assert.match(assistant, /footer-actions/, 'AI 助手应复用 .footer-actions')
  assert.match(assistant, /btn--grow/, '主按钮应撑满操作条')
})

test('创作资料是页面组件：没有浮层容器、没有 ✕、没有 ☰', () => {
  assert.doesNotMatch(materials, /drawer-mask/, '创作资料不该有浮层遮罩')
  assert.doesNotMatch(materials, /drawer--wide/, '创作资料不该用抽屉容器')
  assert.doesNotMatch(materials, /drawer__close/, '创作资料不该有 ✕ 关闭键')
  // ☰ 交给全局顶栏，组件里不该再有（这是第二次踩坑的现场）
  assert.doesNotMatch(materials, /drawer__nav/, '创作资料不该自带 ☰（顶栏已有）')
  assert.doesNotMatch(materials, /onNav/, '创作资料不该再接受 onNav prop')
})

test('创作资料用页面级贴底操作条', () => {
  assert.match(materials, /footer-actions/)
})

test('作品导航里的这一项已改名为「AI 助手」', () => {
  assert.match(navDrawer, /label: 'AI 助手'/, '导航项应叫「AI 助手」')
  assert.doesNotMatch(navDrawer, /创作讨论/, '「创作讨论」这个旧名应已去掉')
})

/* ------------------------------ 样式文件 ------------------------------ */

test('样式里不再残留浮窗头部的规则（已随容器改造移除）', () => {
  const css = src('src/styles/app.css')
  assert.doesNotMatch(css, /^\.drawer--wide/m, '.drawer--wide 已是死代码')
  assert.doesNotMatch(css, /^\.drawer__close/m, '.drawer__close 已是死代码')
  assert.doesNotMatch(css, /^\.nav-fab/m, '.nav-fab 是为浮层叠加准备的护栏，浮层没了就该删')
})

test('编辑区主体不再自己滚（整页由文档流滚动，否则会出现两条滚动条）', () => {
  const css = src('src/styles/app.css')
  const m = css.match(/\.editor-body\{[^}]*\}/)
  assert.ok(m, '找不到 .editor-body 规则')
  assert.doesNotMatch(m[0], /overflow-y:\s*auto/, '.editor-body 不该自建滚动区')
})
