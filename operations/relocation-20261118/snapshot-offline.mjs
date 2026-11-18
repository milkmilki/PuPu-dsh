import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const home = 'C:/Users/57859/.dsh';
const output = join(root, 'offline-backup');
assert(!existsSync(output), 'Backup already exists');
const running = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  String.raw`@((Get-CimInstance Win32_Process -Filter "Name='node.exe'") | Where-Object { $_.CommandLine -match '(?i)(@deepseek-ai[\\/]+dsh[\\/].*--profile\s+web|dsh-pupu-notes[\\/]+dist[\\/]+mcp\.mjs)' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`,
], { encoding: 'utf8' }).trim();
assert(!running || running === '[]', 'Formal DSH or memory writer is still running');
mkdirSync(output);
const items = [
  [join(home, 'profiles/web'), join(output, 'profile'), true],
  [join(home, 'data/pupu-notes'), join(output, 'pupu-notes')],
  [join(home, 'data/dsh-qq'), join(output, 'dsh-qq')],
  [join(home, 'storages/workspace.json'), join(output, 'workspace.json')],
];
const records = [];
function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function compare(source, target) {
  const stat = lstatSync(source);
  assert(!stat.isSymbolicLink(), `Linked backup entry refused: ${source}`);
  if (stat.isDirectory()) {
    for (const name of readdirSync(source)) compare(join(source, name), join(target, name));
  } else {
    assert.equal(hash(source), hash(target), 'Backup hash mismatch');
    records.push({ source, target, bytes: stat.size, sha256: hash(target) });
  }
}
for (const [source, target, profileOnly] of items) {
  if (profileOnly) {
    mkdirSync(target);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const from = join(source, entry.name), to = join(target, entry.name);
      cpSync(from, to, { errorOnExist: true, force: false });
      compare(from, to);
    }
  } else {
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    compare(source, target);
  }
}
const plan = JSON.parse(readFileSync(join(root, 'workspace-relocation.plan.json'), 'utf8'));
for (const session of plan.sessions) {
  const target = join(output, 'native-sessions', session.encodedId);
  cpSync(dirname(session.source), target, { recursive: true, errorOnExist: true, force: false });
  compare(dirname(session.source), target);
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), records }, null, 2));
console.log(JSON.stringify({ backup: output, files: records.length, bytes: records.reduce((sum, row) => sum + row.bytes, 0), hashesVerified: true }));
