import React, { useEffect, useState } from 'react'
import type { BridgeConfig } from '../types'
import styles from './styles.css'
export type Api = (action: string, args?: Record<string, any>) => Promise<any>
export function Settings({ api, open }: { api: Api; open: (sessionId: string) => void }) {
  const [state, setState] = useState<any>(), [config, setConfig] = useState<BridgeConfig>(), [secrets, setSecrets] = useState<Record<string, string>>({})
  const [tab, setTab] = useState('accounts'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false)
  const [root, setRoot] = useState('D:\\ProjectICreate\\PuPuBot\\dsh-qq-workspaces')
  const [approval, setApproval] = useState<any>(), [shared, setShared] = useState(false)
  const refresh = async () => { const next = await api('status'); setState(next); return next }
  useEffect(() => { let live = true; void api('status').then(s => { if (live) { setState(s); setConfig(s.config) } }).catch(e => setError(String(e))); return () => { live = false } }, [])
  useEffect(() => { const timer = setInterval(() => { void refresh().catch(() => {}) }, 3000); return () => clearInterval(timer) }, [])
  const run = async (action: string, args: Record<string, any> = {}) => {
    if (busy) return
    setBusy(true); setError('')
    try { await api(action, args); const s = await refresh(); if (action === 'save' || action === 'create_workspaces') { setConfig(s.config); setDirty(false); setSecrets({}) } }
    catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const edit = (id: string, value: Record<string, any>) => { setConfig(c => c && ({ ...c, accounts: c.accounts.map(a => a.id === id ? { ...a, ...value } : a) })); setDirty(true) }
  if (!state || !config) return <section className="qq-settings"><style>{styles}</style>{error || '正在载入 QQ 连接…'}</section>
  const connectionChanged = config.port !== state.config.port || JSON.stringify(config.accounts) !== JSON.stringify(state.config.accounts) || Object.values(secrets).some(Boolean)
  return <section className="qq-settings" aria-label="QQ 连接"><style>{styles}</style>
    <header><h2>QQ 连接</h2><span>{state.connections.filter((c: any) => c.connected).length} / {config.accounts.length} 在线</span></header>
    {error && <p role="alert" className="qq-error">{error}</p>}{state.error && <p role="alert" className="qq-error">{state.error}</p>}
    <nav aria-label="QQ 设置分类">{[['accounts','账号与工作区'],['contacts',`联系人 (${state.contacts.filter((c: any) => c.status === 'pending').length})`],['routes','会话路由'],['delivery','收发状态']].map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>
    {tab === 'accounts' && <>
      <label>MCP 本机端口<input type="number" min={1024} max={65535} value={config.port} onChange={e => { setConfig({ ...config, port: +e.target.value }); setDirty(true) }} /></label>
      <label title="从最后一条新消息起等待；0 为关闭。每批最多等待 60 秒或接收 20 条。">消息合并等待（秒）<input type="number" min={0} max={60} step={1} value={config.mergeWindowSeconds ?? 20} onChange={e => { setConfig({ ...config, mergeWindowSeconds: +e.target.value }); setDirty(true) }} /></label>
      {config.accounts.map(a => <fieldset key={a.id}><legend>{a.name} · {state.connections.find((c: any) => c.id === a.id)?.connected ? '已连接' : '未连接'}</legend>
        <label className="qq-check"><input type="checkbox" checked={a.enabled} onChange={e => edit(a.id, { enabled: e.target.checked })} />启用账号连接</label>
        <div className="qq-grid"><label>机器人 QQ<input inputMode="numeric" value={a.selfId} onChange={e => edit(a.id, { selfId: e.target.value })} /></label>
          <label>反向 WebSocket 端口<input type="number" min={1024} max={65535} value={a.port} onChange={e => edit(a.id, { port: +e.target.value })} /></label>
          <label>连接凭据<input type="password" autoComplete="new-password" placeholder={state.credentialsSet[a.id] ? '已保存；留空保留' : '与 NapCat 保持一致，至少 16 字符'} value={secrets[a.id] ?? ''} onChange={e => { setSecrets({ ...secrets, [a.id]: e.target.value }); setDirty(true) }} /></label>
          <label>主人 QQ（本机确认）<input inputMode="numeric" value={a.ownerQQ ?? ''} onChange={e => edit(a.id, { ownerQQ: e.target.value })} /></label>
          <label>DSH 工作区<select value={a.workspaceId ?? ''} onChange={e => edit(a.id, { workspaceId: e.target.value })}><option value="">未绑定</option>{state.workspaces.map((w: any) => <option key={w.id} value={w.id}>{w.title || w.path}</option>)}</select></label>
          <label>PuPu 角色<select value={a.roleId ?? ''} onChange={e => edit(a.id, { roleId: e.target.value })}><option value="">未绑定</option>{state.roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        </div>
        <p className="qq-muted">ws://127.0.0.1:{a.port}/onebot/v11/ws</p>
        {state.connections.find((c: any) => c.id === a.id)?.error && <p className="qq-error">{state.connections.find((c: any) => c.id === a.id).error}</p>}
      </fieldset>)}
      <button disabled={busy || !dirty} onClick={() => { if (!connectionChanged || window.confirm('保存账号连接及主人 QQ 映射？更改角色、工作区或主人后，已有路由将暂停，需开始新聊天。')) void run('save', { config, secrets }) }}>保存连接设置</button>
      <details><summary>创建角色工作区</summary><label>工作区根目录<input value={root} onChange={e => setRoot(e.target.value)} /></label><button disabled={busy || dirty} onClick={() => void run('create_workspaces', { root })}>创建仆仆与璐璐工作区</button></details>
    </>}
    {tab === 'contacts' && <>
      <p className="qq-warning">批准后，该联系人将使用对应 DSH 对话的工具权限，并共享角色的整库记忆，包括此前与主人的记忆。私聊之间不提供记忆隔离。</p>
      {!state.contacts.length && <p className="qq-muted">暂无联系人</p>}
      {state.contacts.map((c: any) => <article key={`${c.account}:${c.peer}`}><div><strong>{c.nickname}</strong><small>{c.peer} · {c.account} · {c.status === 'approved' ? '已批准' : c.status === 'rejected' ? '已拒绝' : '待批准'}</small></div><div className="qq-actions"><button disabled={busy || c.status === 'approved'} onClick={() => { setApproval(c); setShared(false) }}>批准</button><button disabled={busy || c.status === 'rejected'} onClick={() => void run('reject', c)}>拒绝</button></div></article>)}
      {approval && <div role="dialog" aria-modal="true" aria-label="批准联系人" className="qq-dialog"><h3>批准 {approval.peer}</h3><p>此联系人可访问角色已有记忆；工具授权和审批沿用其 DSH 对话。</p><label className="qq-check"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />我确认共享该角色整库记忆</label><div className="qq-actions"><button disabled={!shared || busy} onClick={async () => { await run('approve', { account: approval.account, peer: approval.peer, sharedMemoryConfirmed: true }); setApproval(undefined) }}>确认批准</button><button onClick={() => setApproval(undefined)}>取消</button></div></div>}
    </>}
    {tab === 'routes' && <>{!state.routes.length && <p className="qq-muted">暂无绑定对话</p>}{state.routes.map((r: any) => <article key={`${r.account}:${r.peer}`}><div><strong>{r.account} · {r.peer}</strong><small>{r.status === 'active' ? '最终回复自动转发' : '已暂停'} · {r.sessionId}</small>{r.error && <p className="qq-error">{r.error}</p>}</div><div className="qq-actions"><button onClick={() => open(r.sessionId)}>打开对话</button><button disabled={busy} onClick={() => void run(r.status === 'active' ? 'pause' : 'resume', r)}>{r.status === 'active' ? '暂停' : '恢复'}</button><button disabled={busy} onClick={() => { if (window.confirm('开始新聊天？原 DSH 对话保留，之后不再自动转发。')) void run('new_chat', r) }}>开始新聊天</button></div></article>)}</>}
    {tab === 'delivery' && <><h3>待处理来信</h3>{!state.inbox.length && <p className="qq-muted">无待处理来信</p>}{state.inbox.map((m: any) => <article key={m.key}><div><strong>{m.account} · {m.peer}</strong><small>{m.status} · {m.id}{m.batchSize > 1 && ` · 合并批次 ${m.batchSize} 条`}</small>{m.error && <p className="qq-error">{m.error}</p>}</div><div className="qq-actions">{m.status === 'error' && <button disabled={busy} onClick={() => { if (!(m.batchSize > 1) || window.confirm(`重试整个合并批次（${m.batchSize} 条）？`)) void run('retry_input', { key: m.key }) }}>重试</button>}<button disabled={busy} onClick={() => { if (!(m.batchSize > 1) || window.confirm(`丢弃整个合并批次（${m.batchSize} 条）？已提交到 DSH 的内容不会撤回。`)) void run('discard_input', { key: m.key }) }}>丢弃</button></div></article>)}
      <h3>待发送与异常</h3>{!state.outbox.length && <p className="qq-muted">无待发送或异常消息</p>}{state.outbox.map((m: any) => <article key={m.key}><div><strong>{m.account} · {m.peer}</strong><small>{m.status} · {m.key}</small>{m.error && <p className="qq-error">{m.error}</p>}</div><div className="qq-actions">{['failed','uncertain'].includes(m.status) && <button disabled={busy} onClick={() => { if (window.confirm('请先检查 QQ 是否已收到。重试结果未知的发送可能产生重复消息。')) void run('retry_send', { key: m.key, duplicateRiskConfirmed: true }) }}>人工重试</button>}{m.status === 'uncertain' && <button disabled={busy} onClick={() => { if (window.confirm('确认已在 QQ 核实收到此条消息？这会解除后续发送的等待。')) void run('confirm_send', { key: m.key, receivedConfirmed: true }) }}>确认已收到</button>}</div></article>)}</>}
  </section>
}
