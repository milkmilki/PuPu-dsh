import { request } from 'node:https'
import { lookup } from 'node:dns/promises'
export function publicIPv4(ip: string) {
  const [a, b] = ip.split('.').map(Number)
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19].includes(b))
}
export function imageUrl(raw: unknown): URL {
  const url = new URL(String(raw))
  const trusted = url.hostname === 'multimedia.nt.qq.com.cn' || ['qpic.cn', 'qq.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !trusted) throw new Error('图片地址不是受支持的 QQ HTTPS 图片地址')
  return url
}
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const b = Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString())) return 'image/gif'
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new Error('图片格式损坏或不支持')
}
export async function downloadImage(raw: unknown, max: number, signal: AbortSignal): Promise<Buffer> {
  const url = imageUrl(raw)
  const addresses = await lookup(url.hostname, { all: true, family: 4 })
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error('图片域名解析到非公网地址')
  // Pin the checked DNS answer for this TLS request; do not follow redirects.
  return new Promise((resolve, reject) => {
    const req = request(url, { signal, lookup: (_host, opts, cb: any) => (opts as any).all ? cb(null, addresses) : cb(null, addresses[0].address, 4), timeout: 15000 }, res => {
      if (res.statusCode !== 200 || Number(res.headers['content-length'] ?? 0) > max) { res.destroy(); reject(new Error('图片地址失效或图片超限')); return }
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (b: Buffer) => { size += b.length; if (size > max) res.destroy(new Error('图片超限')); else chunks.push(b) })
      res.on('error', () => reject(new Error('图片下载失败')))
      res.on('end', () => { try { const data = Buffer.concat(chunks); imageType(data); resolve(data) } catch (e) { reject(e) } })
    })
    req.on('timeout', () => req.destroy(new Error('图片下载超时')))
    req.on('error', () => reject(new Error('图片下载失败或取消'))); req.end()
  })
}
