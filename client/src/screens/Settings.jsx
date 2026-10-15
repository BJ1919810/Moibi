import { useState } from 'react'
import { api } from '../lib/api.js'

const PRESETS = [
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' },
  {
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { label: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
]

export default function Settings({ config, onSaved }) {
  const [baseURL, setBaseURL] = useState(config?.baseURL || '')
  const [model, setModel] = useState(config?.model || '')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const patch = {}
      if (baseURL.trim()) patch.baseURL = baseURL.trim()
      if (model.trim()) patch.model = model.trim()
      if (apiKey.trim()) patch.apiKey = apiKey.trim()
      const c = await api.saveConfig(patch)
      onSaved(c)
      setApiKey('')
      setMsg({ type: 'ok', text: '已保存。可以点「测试连接」确认一下。' })
    } catch (e) {
      setMsg({ type: 'err', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.testConfig()
      if (!r.ok) {
        setMsg({ type: 'err', text: r.error })
      } else if (r.modelFound === false) {
        setMsg({
          type: 'warn',
          text: `连通成功，但模型「${model || '（空）'}」不在账号可用列表里。可用：${r.models.join('、')}`,
        })
      } else if (r.mode === 'models') {
        setMsg({
          type: 'ok',
          text: r.models.length
            ? `连通成功。账号可用模型：${r.models.join('、')}`
            : '连通成功（该接口未返回模型列表）。',
        })
      } else {
        setMsg({ type: 'ok', text: `连通成功，模型回了「${r.reply}」。` })
      }
    } catch (e) {
      setMsg({ type: 'err', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="setting-item">
        <label className="label">服务商预设</label>
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="chip"
              onClick={() => {
                setBaseURL(p.baseURL)
                setModel(p.model)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="setting-note">点一下自动填好地址与模型名，再补上你的密钥即可。</div>
      </div>

      <div className="setting-item">
        <label className="label">接口地址</label>
        <input
          className="field"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder="https://api.deepseek.com"
          autoComplete="off"
        />
        <div className="setting-note">
          需兼容 OpenAI 的 /chat/completions 协议。绝大多数国内模型都支持。
        </div>
      </div>

      <div className="setting-item">
        <label className="label">模型</label>
        <input
          className="field"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="deepseek-flash"
          autoComplete="off"
        />
        <div className="setting-note">
          DeepSeek 当前的模型 ID 是 deepseek-flash（V4.1-Flash）。成本优先就选便宜的。
        </div>
      </div>

      <div className="setting-item">
        <label className="label">API 密钥</label>
        <div className="key-row">
          <input
            className="field"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasKey ? `已保存（尾号 ${config.keyTail}），留空则不修改` : 'sk-...'}
            autoComplete="off"
          />
          <button className="icon-btn icon-btn--text" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="setting-note">
          密钥只保存在这台电脑的后端，不经过手机、不写入日志。前端界面永远读不到明文。
        </div>
      </div>

      {msg ? <div className={`notice notice--${msg.type}`}>{msg.text}</div> : null}

      <div className="spacer" />
      <div className="footer-actions">
        <button className="btn btn--ghost" onClick={test} disabled={busy}>
          测试连接
        </button>
        <button className="btn btn--primary btn--grow" onClick={save} disabled={busy}>
          {busy ? '处理中…' : '保存'}
        </button>
      </div>
    </>
  )
}
