import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const npm = process.env.npm_execpath
if (!npm) throw new Error('请通过 npm run check-package 执行')
const result = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--json'], { encoding: 'utf8' }))
const pkg = Array.isArray(result) ? result[0] : result['dsh-qq']
assert(pkg?.files?.length, '没有可发行文件')
for (const file of pkg.files)
  assert(!/(^|\/)(?:node_modules|recovery|tests|\.test-data|artifacts)(?:\/|$)|\.(?:db|sqlite|pupunotes)$|credentials\.json$/.test(file.path), `发行包包含开发或私人资料：${file.path}`)
assert(pkg.files.some(file => file.path === 'dist/index.js'), '缺少宿主入口')
assert(pkg.files.some(file => file.path === 'dist/client.js'), '缺少 UI 入口')
assert(pkg.files.some(file => file.path === 'cordis.patch.yml'), '缺少 DSH bundle')
console.log(JSON.stringify({ version: pkg.version, files: pkg.files.length, privateDataExcluded: true }))
