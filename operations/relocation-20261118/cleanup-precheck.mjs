import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

const root = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129';
const reports = `${root}/operations/relocation-20261118`;
const originalScripts = `${reports}/offline-backup/legacy-activation-scripts`;
const groups = [
  { name: 'source', from: 'C:/Users/57859/Projects/dsh-qq-notes', to: `${root}/dsh-qq-notes` },
  { name: 'build', from: 'C:/Users/57859/.codex/tmp/dsh-qq-build-20261118', to: `${root}/.build/dsh-qq-build-20261118` },
  { name: 'activation', from: 'C:/Users/57859/.dsh/backups/pupu-notes-activation-2026-11-18T01-31-10-926Z', to: `${root}/operations/pupu-notes-activation-2026-11-18T01-31-10-926Z` },
  { name: 'auditTemp', from: 'C:/Users/57859/AppData/Local/Temp/pupu-dialogue-count-20BsLb', to: `${root}/operations/disk-audit-dialogue-copy` },
];
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function scan(directory) {
  const queue = [directory], files = [], links = [];
  for (let i = 0; i < queue.length; i++) {
    for (const entry of await readdir(queue[i], { withFileTypes: true })) {
      const filename = path.join(queue[i], entry.name), stat = await lstat(filename);
      const relative = path.relative(directory, filename).replaceAll('\\', '/');
      if (stat.isSymbolicLink()) links.push({ path: relative, target: await readlink(filename) });
      else if (stat.isDirectory()) queue.push(filename);
      else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, filename });
      else throw new Error(`Unsupported entry: ${filename}`);
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      file.sha256 = await digest(file.filename);
      delete file.filename;
    }
  }));
  return { files: new Map(files.map(file => [file.path, file])), links };
}
async function archiveDigest(archive, entry) {
  const process = spawn('tar', ['-xOf', archive, `package/${entry}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', code => code === 0 ? resolve() : reject(new Error(`tar failed: ${code}`)));
  });
  const hash = createHash('sha256');
  for await (const chunk of process.stdout) hash.update(chunk);
  await done;
  return hash.digest('hex');
}
const results = [];
for (const group of groups) {
  const source = await scan(group.from), destination = await scan(group.to);
  const different = [], missing = [], extra = [];
  let matching = 0;
  for (const [name, original] of source.files) {
    const copy = destination.files.get(name);
    if (copy?.sha256 === original.sha256) matching++;
    else (copy ? different : missing).push({
      path: name, sourceBytes: original.bytes, sourceSha256: original.sha256,
      ...(copy ? { destinationBytes: copy.bytes, destinationSha256: copy.sha256 } : {}),
    });
  }
  for (const [name, file] of destination.files) if (!source.files.has(name)) extra.push(file);
  for (const file of [...different, ...missing]) {
    if (group.name === 'source' && file.path.startsWith('dist/')) {
      const archive = `${group.to}/artifacts/dsh-qq-0.1.6.tgz`;
      const hash = await archiveDigest(archive, file.path);
      file.originalCopy = { path: archive, entry: `package/${file.path}`, sha256: hash, verified: hash === file.sourceSha256 };
    } else if (group.name === 'activation') {
      const backup = path.join(originalScripts, file.path);
      await mkdir(path.dirname(backup), { recursive: true });
      let existing = false;
      try { await lstat(backup); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) assert.equal(await digest(backup), file.sourceSha256, `Backup collision: ${backup}`);
      else await copyFile(path.join(group.from, file.path), backup);
      const hash = await digest(backup);
      assert.equal(hash, file.sourceSha256);
      file.originalCopy = { path: backup, sha256: hash, verified: true };
    }
  }
  const unresolved = [...different, ...missing].filter(file => !file.originalCopy?.verified);
  const result = {
    ...group, sourceFiles: source.files.size, destinationFiles: destination.files.size, matching,
    different, missing, extra, sourceLinks: source.links, destinationLinks: destination.links,
    allOriginalFilesPreserved: unresolved.length === 0, unresolved: unresolved.map(file => file.path),
  };
  results.push(result);
  console.log(JSON.stringify({ group: group.name, matching, different: different.map(file => file.path), missing: missing.map(file => file.path), extra: extra.map(file => file.path), unresolved: result.unresolved }));
}
const git = directory => ({
  head: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-uall'], { cwd: directory, encoding: 'utf8' }).trim(),
});
const profileRoot = 'C:/Users/57859/.dsh/profiles/web';
const profileFiles = ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'];
const oldSourceReference = /(?:file:)?C:[/\\]+Users[/\\]+57859[/\\]+Projects[/\\]+dsh-qq-notes|file:\.\.\/\.\.\/\.\.\/Projects\/dsh-qq-notes/i;
const references = await Promise.all(profileFiles.map(async name => ({
  path: `${profileRoot}/${name}`, oldSourceReference: oldSourceReference.test(await readFile(`${profileRoot}/${name}`, 'utf8')),
})));
const sourceGit = git(groups[0].from), destinationGit = git(groups[0].to);
const unexpectedSourceLinks = results.flatMap(group => group.sourceLinks.filter(link =>
  !(group.name === 'source' && link.path === 'node_modules' &&
    path.win32.normalize(link.target).toLowerCase() === path.win32.normalize(`${groups[1].from}/runtime/node_modules`).toLowerCase()))
  .map(link => ({ group: group.name, ...link })));
const gitStateMatches = sourceGit.head === destinationGit.head && sourceGit.status === '' && destinationGit.status === '';
const report = {
  checkedAt: new Date().toISOString(), root, groups: results,
  git: { source: sourceGit, destination: destinationGit, matches: gitStateMatches },
  profileReferences: references,
  unexpectedSourceLinks,
  safeToCleanOriginalCPaths: results.every(group => group.allOriginalFilesPreserved) &&
    references.every(file => !file.oldSourceReference) && gitStateMatches && unexpectedSourceLinks.length === 0,
  cleanupPaths: groups.map(group => group.from),
  caveat: 'Remove the source node_modules junction without recursion before recursively removing the exact C source root. No deletion was performed.',
};
await writeFile(`${reports}/cleanup-precheck.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: `${reports}/cleanup-precheck.json`, safeToCleanOriginalCPaths: report.safeToCleanOriginalCPaths }));
