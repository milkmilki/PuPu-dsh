import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

test('published browser factory loads with only DSH baseline modules and mounts its remote', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' })
  const require = createRequire(import.meta.url)
  const requested: string[] = []
  let plugin: any, registrationCount = 0
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(entry: any) {
      registrationCount++
      assert.equal(entry.id, 'dsh-qq')
      plugin = entry.factory((id: string) => {
        requested.push(id)
        assert(['react', 'react/jsx-runtime', '@deepseek-ai/cordis'].includes(id),
          `Browser module is not supplied by the DSH baseline: ${id}`)
        return require(id)
      })
    } } },
  })
  assert.equal(registrationCount, 1)
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'remote'])
  assert(requested.includes('react'))
  let mounted: any, unmounted = false, disposed = false
  const stop = await plugin.apply({
    remote: { $mount: async (info: any) => { mounted = info; return () => { unmounted = true } } },
    inject: () => ({ dispose: () => { disposed = true } }),
  })
  assert(mounted.descriptors.some((descriptor: any) => descriptor.method === 'request'))
  await stop()
  assert.equal(unmounted, true)
  assert.equal(disposed, true)
})
