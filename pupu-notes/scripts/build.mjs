import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('dist', { recursive: true });
const shared = { bundle: true, sourcemap: true, target: 'es2023', logLevel: 'info' };
const node = {
  ...shared, platform: 'node', format: 'esm',
  banner: { js: 'import { createRequire as __pupuCreateRequire } from "node:module";const require=__pupuCreateRequire(import.meta.url);' },
};
await build({ ...node, entryPoints: ['src/host/index.ts'], outfile: 'dist/host.mjs', external: ['@deepseek-ai/*', 'react', 'react/*'] });
await build({ ...node, entryPoints: ['src/mcp/entry.ts'], outfile: 'dist/mcp.mjs' });
const client = await build({
  ...shared, platform: 'browser', format: 'cjs',
  entryPoints: ['src/ui/index.tsx'], write: false, sourcemap: false,
  external: ['@deepseek-ai/cordis', 'react', 'react/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-pupu-notes",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('dist/build-info.json', JSON.stringify({ name: pkg.name, version: pkg.version, node: process.version, builtAt: new Date().toISOString(), dsh: '0.2.1-rc.2' }, null, 2));
