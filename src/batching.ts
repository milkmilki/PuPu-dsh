import type { Inbox } from './types'

export const DEFAULT_MERGE_SECONDS = 20
export const MAX_BATCH_WAIT_MS = 60000
export const MAX_BATCH_MESSAGES = 20
const MAX_BATCH_BYTES = 256 * 1024

/** Select one chronological burst, without changing or claiming its input. */
export function readyBatch(items: Inbox[], now: number, seconds: number, maxImages: number): Inbox[] | undefined {
  if (!items.length) return
  const first = items[0]
  if (!seconds || first.receivedAt === undefined || first.receivedAt > now) return [first]
  const result: Inbox[] = []
  let last = first.receivedAt, bytes = 0, images = 0, bounded = false
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item.segments))
    const count = item.segments.filter(s => s.type === 'image').length
    if (result.length && (item.receivedAt === undefined || item.receivedAt - last > seconds * 1000
      || item.receivedAt - first.receivedAt >= MAX_BATCH_WAIT_MS
      || bytes + size > MAX_BATCH_BYTES || images + count > maxImages)) { bounded = true; break }
    result.push(item); bytes += size; images += count; last = item.receivedAt!
    if (result.length >= MAX_BATCH_MESSAGES || bytes >= MAX_BATCH_BYTES || images >= maxImages) { bounded = true; break }
  }
  if (bounded || now >= Math.min(last + seconds * 1000, first.receivedAt + MAX_BATCH_WAIT_MS)) return result
}
