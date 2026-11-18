import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { DEFAULT_MERGE_SECONDS } from './batching'
export const accountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), name: z.string().min(1).max(100),
  selfId: z.string().regex(/^$|^[1-9][0-9]{4,15}$/), port: z.number().int().min(1024).max(65535), enabled: z.boolean(),
  workspaceId: z.string().optional(), roleId: z.string().optional(), ownerQQ: z.string().regex(/^$|^[1-9][0-9]{4,15}$/).optional(),
}).strict()
export const configSchema = z.object({ port: z.number().int().min(1024).max(65535), accounts: z.array(accountSchema).max(10), mergeWindowSeconds: z.number().min(0).max(60).default(DEFAULT_MERGE_SECONDS) }).strict().superRefine((c, ctx) => {
  if (new Set(c.accounts.map(a => a.id)).size !== c.accounts.length) ctx.addIssue({ code: 'custom', message: '账号连接 ID 重复' })
  const ports = [c.port, ...c.accounts.filter(a => a.enabled).map(a => a.port)]
  if (new Set(ports).size !== ports.length) ctx.addIssue({ code: 'custom', message: '端口重复' })
  for (const a of c.accounts) if (a.enabled && (!a.selfId || !a.workspaceId || !a.roleId)) ctx.addIssue({ code: 'custom', message: `${a.name} 缺少账号、工作区或角色绑定` })
})
export const newSecret = () => randomBytes(32).toString('base64url')
export function secretMatches(actual: string, expected: string) {
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b)
}
export class Credentials {
  readonly path: string
  private data: { gateway: string; accounts: Record<string, string> }
  constructor(root: string) {
    this.path = join(root, 'credentials.json')
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { gateway: newSecret(), accounts: {} }
    this.save()
  }
  get gateway() { return this.data.gateway }
  account(id: string) { return this.data.accounts[id] }
  setAccount(id: string, secret: string) {
    if (secret.length < 16 || secret.length > 512 || /[\r\n]/.test(secret)) throw new Error('连接凭据须为 16–512 个非换行字符')
    this.data.accounts[id] = secret; this.save()
  }
  private save() {
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 })
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/)?.[0]
      if (!sid) throw new Error('无法确认本机用户，拒绝保存未受保护的凭据')
      execFileSync('icacls.exe', [this.path, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { windowsHide: true, stdio: 'pipe' })
    }
  }
}
