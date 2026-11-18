#!/usr/bin/env node
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Store } from './store'
import { Credentials, configSchema } from './config'
import { Gateway } from './gateway'
const root = process.argv[2]
if (!root) { console.error('Usage: dsh-qq <absolute-data-directory>'); process.exit(1) }
mkdirSync(resolve(root), { recursive: true })
const store = new Store(resolve(root)), credentials = new Credentials(store.root)
configSchema.parse(store.config())
const gateway = new Gateway(store, credentials)
try { await gateway.start() } catch (e) { console.error(e instanceof Error ? e.message : 'Gateway failed'); store.close(); process.exit(1) }
console.log(`DSH QQ gateway: http://127.0.0.1:${store.config().port}/mcp (credentials in private data directory)`)
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true
  void gateway.close().then(() => { store.close(); process.exit(0) })
})
