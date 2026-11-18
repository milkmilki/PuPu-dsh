import { createHash } from 'node:crypto'
import type { Incoming } from './types'
export const qq = (value: unknown): string => {
  const text = String(value ?? '')
  if (!/^[1-9][0-9]{4,15}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('QQ 号码无效')
  return text
}
export const messageKey = (account: string, id: string) => createHash('sha256').update(JSON.stringify([account, id])).digest('hex')
export function parsePrivate(account: string, self: string, event: any): Incoming | null {
  if (event?.post_type !== 'message' || event.message_type !== 'private' || String(event.self_id) !== self) return null
  try {
    const peer = qq(event.user_id)
    if (peer === self || !Array.isArray(event.message) || event.message.length > 100 || !['string', 'number'].includes(typeof event.message_id)) return null
    if (!event.message_id || String(event.message_id).length > 128) return null
    const segments = event.message.filter((s: any) => s && ['text', 'image'].includes(s.type) && s.data && typeof s.data === 'object')
    if (!segments.length || JSON.stringify(segments).length > 262144) return null
    if (segments.some((s: any) => s.type === 'text' && typeof s.data.text !== 'string')) return null
    return { account, peer, id: String(event.message_id), nickname: String(event.sender?.nickname ?? peer).slice(0, 100), segments }
  } catch { return null }
}
export function splitText(text: string, max = 3000): string[] {
  const chars = [...text], result: string[] = []
  for (let offset = 0; offset < chars.length; offset += max) result.push(chars.slice(offset, offset + max).join(''))
  return result
}
