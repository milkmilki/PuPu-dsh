import { splitText } from './protocol'

export function splitReply(text: string): string[] {
  return text.split(/\r\n|[\r\n]/).filter(line => line.trim()).flatMap(line => splitText(line))
}

export function completedReply(events: readonly any[], end: any): { id: string; text: string } | null {
  if (end.type !== 'turn/end' || end.data?.reason?.kind !== 'completed') return null
  const messages = events.filter(e => e.seq <= end.seq && e.type === 'assistant/message' && e.data?.turn === end.data.turn)
  const message = messages.at(-1)?.data?.message
  if (!message?.id || !Array.isArray(message.content) || message.content.some((p: any) => p.type === 'tool-call')) return null
  const text = message.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').trim()
  return text ? { id: message.id, text } : null
}
