import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir('dist', { recursive: true })
const shared = { bundle: true, sourcemap: true, target: 'es2023', logLevel: 'info' }
const node = {
  ...shared, platform: 'node', format: 'esm', external: ['@deepseek-ai/*', 'react', 'react/*'],
  banner: { js: 'import { createRequire as __qqCreateRequire } from "node:module";const require=__qqCreateRequire(import.meta.url);' },
}
for (const entry of ['index', 'remote', 'cli'])
  await build({ ...node, entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.js` })
const client = await build({
  ...shared, sourcemap: false, platform: 'browser', format: 'cjs',
  entryPoints: ['src/client.tsx'], write: false, loader: { '.css': 'text' },
  external: ['@deepseek-ai/cordis', 'react', 'react/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
await writeFile('dist/client.js',
  `window.__ModuleLoader__.load({id:"dsh-qq",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)
