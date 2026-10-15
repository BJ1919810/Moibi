import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as store from '../server/store.js'
import { createApiRouter } from '../server/api-router.js'

/**
 * 数据安全两件：
 *   ① `DELETE /api/projects/:id` 原来直接 `unlinkSync` —— 作品与它的修改请求当场消失、无法撤销。
 *      现在**先备份再删**，而且**备份失败就取消删除**。
 *   ② `POST /api/projects/:id/outline`（重建大纲）走的是通用写 `saveProject`（**非 CAS**），
 *      于是「另一个标签页刚改完设定 → 旧标签页点重建」会安静地冲掉那些改动。
 *      现在补上 CAS 入口检查，并拒绝与正在跑的任务并行（两条都在同一份项目上写）。
 *
 * ⚠️ 这些用例**不会触发任何模型调用**：两条护栏都在模型调用**之前**返回。
 */

const DATA = process.env.MOBI_DATA_DIR
const mkProject = () => {
  const p = store.createProjectBase({ idea: '删除与重建大纲的测试用书', targetChapters: 3 })
  store.saveProject(p)
  return p
}
// ⚠️ `createApiRouter` 的依赖是**必填**的（没有默认值）：只测这两条护栏时
//    其余服务可以给占位对象 —— 两条护栏都在**调用它们之前**就返回了。
const handle = createApiRouter({
  store, pipeline: {}, workflow: {}, replanner: {}, assistant: {}, changes: {},
  testConnection: async () => ({}), validateChapterCount: (n) => n, normalizeGenreTags: (t) => t,
})

test('DELETE：先备份再删，备份里能恢复出完整的作品与它的修改请求', async () => {
  const p = mkProject()
  const crId = 'cr_' + 'a'.repeat(24)
  store.saveChange({ id: crId, projectId: p.id, status: 'pending', change: { kind: 'book_title' }, impact: {} })

  const res = await handle({ path: `/api/projects/${p.id}`, method: 'DELETE', query: {}, body: {} })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.ok, true)
  assert.ok(res.data.backup, '必须返回备份路径')
  assert.ok(fs.existsSync(path.join(res.data.backup, 'project.json')), '备份里必须有完整作品')
  assert.ok(fs.existsSync(path.join(res.data.backup, `${crId}.json`)), '修改请求也要一起备份')
  assert.equal(store.getProject(p.id), null, '作品本体应已删除')
  const restored = JSON.parse(fs.readFileSync(path.join(res.data.backup, 'project.json'), 'utf8'))
  assert.equal(restored.id, p.id, '备份必须可直接恢复')
})

test('⛔ 备份失败就取消删除（宁可删不掉，也不能悄悄丢数据）', async () => {
  const p = mkProject()
  // 把「备份目录」的位置占成一个**文件** ⇒ mkdir 必然失败。
  // ⚠️ 必须先清掉前面用例留下的真备份目录，否则 writeFileSync 会因 EISDIR 先炸（我第一版就栽在这）
  const trash = path.join(DATA, 'projects', 'trash')
  fs.rmSync(trash, { recursive: true, force: true })
  fs.writeFileSync(trash, 'blocked')
  try {
    const res = await handle({ path: `/api/projects/${p.id}`, method: 'DELETE', query: {}, body: {} })
    assert.equal(res.status, 409, JSON.stringify(res.data))
    assert.match(res.data.error, /备份失败/)
    assert.equal(store.getProject(p.id)?.id, p.id, '备份失败时作品必须原封不动')
  } finally {
    fs.rmSync(trash, { force: true })
  }
})

test('DELETE：作品不存在时明确报错，不假装成功', async () => {
  // ⚠️ id 必须匹配路由的 `[\w-]+`（中文不匹配，那样会落到 404「接口不存在」，测不到删除本身）
  const res = await handle({ path: '/api/projects/p_nonexistent123', method: 'DELETE', query: {}, body: {} })
  assert.equal(res.status, 409, JSON.stringify(res.data))
  assert.match(res.data.error, /不存在|非法/)
})

test('POST /outline：editRevision 不一致直接 409（非 CAS 写必须在这道口子上挡住）', async () => {
  const p = mkProject()
  const res = await handle({ path: `/api/projects/${p.id}/outline`, method: 'POST', query: {}, body: { expectedEditRevision: 999 } })
  assert.equal(res.status, 409, JSON.stringify(res.data))
  assert.match(res.data.error, /设定已被修改/)
})

test('POST /outline：有任务正在跑时拒绝（否则两边同时写同一份项目）', async () => {
  const p = mkProject()
  store.saveRun({ id: 'run_' + 'b'.repeat(24), projectId: p.id, status: 'writing', type: 'chapter' })
  const res = await handle({ path: `/api/projects/${p.id}/outline`, method: 'POST', query: {}, body: {} })
  assert.equal(res.status, 409, JSON.stringify(res.data))
  assert.match(res.data.error, /有任务正在执行/)
})
