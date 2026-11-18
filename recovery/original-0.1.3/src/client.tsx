import React, { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import remote from './remote'
import { Settings, type Api } from './ui/settings'
import styles from './ui/styles.css'
export const inject = ['slots', 'remote']
function Bound({ api, sessionId }: { api: Api; sessionId: string }) {
  const [route, setRoute] = useState<any>()
  useEffect(() => {
    let live = true
    const update = () => api('status').then(s => { if (live) setRoute(s.routes.find((r: any) => r.sessionId === sessionId)) }).catch(() => {})
    void update(); const timer = setInterval(() => void update(), 3000)
    return () => { live = false; clearInterval(timer) }
  }, [sessionId])
  return route ? <span className="qq-bound"><style>{styles}</style>QQ {route.peer} · {route.status === 'active' ? '最终回复自动转发' : '转发已暂停'}</span> : null
}
export async function apply(ctx: Context) {
  const unmount = await ctx.remote.$mount(remote)
  const bindings = ctx.inject(['remote.qqBridge', 'remote.pluginManager', 'uiWorkspace'], child => {
    const descriptor = remote.descriptors.find(d => d.method === 'request')!
    const api: Api = async (action, args = {}) => {
      const result = await (descriptor as any).invoke(child.remote, { input: { action, args } })
      if (!result.ok) throw new Error(result.error?.message ?? 'QQ 请求失败')
      return result.value
    }
    let remove: (() => void) | undefined, enabled: boolean | undefined, disposed = false
    const refresh = async () => {
      const result = await child.remote.pluginManager.listPlugins(); if (!result.ok || disposed) return
      const next = result.value.some(p => p.moduleName === 'dsh-qq' && p.enabled)
      if (next === enabled) return
      enabled = next; remove?.()
      if (!next) return
      const settings = child.slots.inject('plugins.bundle.config', () => child.slots.register({ name: 'plugins.bundle.config', key: 'dsh-qq', inject: () => ({ api, open: (id: string) => child.uiWorkspace.openSession(id as any) }) }, Settings))
      const bound = child.slots.inject('conversation.input.left', () => child.slots.register({ name: 'conversation.input.left', id: 'qq-contact', order: 30, inject: () => ({ api }) }, Bound))
      remove = () => { settings(); bound() }
    }
    void refresh()
    const changed = child.remote.$on('plugin-manager/changed', () => { void refresh() })
    return () => { disposed = true; changed(); remove?.() }
  })
  return () => { bindings.dispose(); return unmount() }
}
