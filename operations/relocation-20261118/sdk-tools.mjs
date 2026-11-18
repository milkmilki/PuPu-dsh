import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cached = new Map();
const defaultManifest = 'C:/Users/57859/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json';

/** Expose installed SDK helpers in this offline process; never modify or start the SDK. */
export async function loadSdk(manifest = defaultManifest) {
  const require = createRequire(pathToFileURL(manifest));
  const sourceFile = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
  const bytes = readFileSync(sourceFile), sourceHash = sha256(bytes);
  if (cached.has(sourceHash)) return cached.get(sourceHash);
  const packageFile = join(dirname(sourceFile), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  assert.equal(pkg.version, '0.2.1-rc.2', 'Only the reviewed installed SDK release is supported');
  let source = bytes.toString('utf8');
  for (const anchor of [
    'function toHeaderLine(', 'function generationLogPath(', 'function sessionDir(',
    'function projectDir(', 'function scanZstdFrames(', 'function compressZstdFrame(',
    'function decompressZstdFrame(', 'var SessionLogScanner = class',
  ]) assert.equal(source.split(anchor).length - 1, 1, `Installed SDK helper anchor changed: ${anchor}`);
  assert(source.includes('export { Config, JsonlCompressionSchema, apply, name };'), 'SDK export layout changed');
  const sdkRequire = createRequire(pathToFileURL(sourceFile));
  // Only top-level emitted import declarations are rewritten. Each dependency
  // still resolves to its original installed module, including shared runtimes.
  source = source.split('\n').map(line => line.replace(
    /^(import .+? from )"([^"]+)";$/,
    (_all, prefix, specifier) => `${prefix}"${specifier.startsWith('node:') ? specifier
      : pathToFileURL(sdkRequire.resolve(specifier)).href}";`,
  )).join('\n');
  source += '\nexport { toHeaderLine, generationLogPath, sessionDir, projectDir, encodeSegment, scanZstdFrames, compressZstdFrame, decompressZstdFrame, SessionLogScanner, eventLines };\n//# sourceURL=pupu-installed-session-sdk.mjs\n';
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const names = [
    'toHeaderLine', 'generationLogPath', 'sessionDir', 'projectDir', 'encodeSegment',
    'scanZstdFrames', 'compressZstdFrame', 'decompressZstdFrame', 'SessionLogScanner', 'eventLines',
  ];
  const result = Object.fromEntries(names.map(name => {
    assert.equal(typeof runtime[name], 'function', `Missing SDK helper: ${name}`);
    return [name, runtime[name]];
  }));
  result.provenance = { manifest, version: pkg.version, sourceFile, sourceSha256: sourceHash };
  cached.set(sourceHash, result);
  return result;
}

/** Validate with the official strict decoder and preserve every compressed event byte. */
export async function rewriteSession(sdk, bytes, cwd, expectedId) {
  const scanned = sdk.scanZstdFrames(bytes);
  assert.equal(scanned.tornStart, undefined, 'A torn session must not be silently repaired');
  assert(scanned.frames.length > 0, 'Empty session artifact');
  const header = await sdk.decompressZstdFrame(bytes.subarray(0, scanned.frames[0].end));
  assert.equal(header.indexOf(10), header.length - 1, 'First frame must contain exactly one header');
  const reader = new sdk.SessionLogScanner(header, 'strict');
  for (const frame of scanned.frames.slice(1))
    reader.write(await sdk.decompressZstdFrame(bytes.subarray(frame.start, frame.end)));
  const before = reader.finish();
  assert.equal(before.meta.id, expectedId, 'Session identity mismatch');
  assert.equal(before.meta.version, 4, 'Only current v4 artifacts are supported');
  const physical = sdk.toHeaderLine({ ...before.meta, cwd }, before.inheritedEventCount);
  const encoded = Buffer.from(JSON.stringify(physical) + '\n');
  const check = new sdk.SessionLogScanner(encoded, 'strict');
  const oldPhysical = JSON.parse(header.toString('utf8'));
  assert.deepEqual(physical, { ...oldPhysical, cwd }, 'Only header cwd may change');
  const first = await sdk.compressZstdFrame(encoded);
  const tail = bytes.subarray(scanned.frames[0].end);
  const result = Buffer.concat([first, tail]);
  const outputFrames = sdk.scanZstdFrames(result);
  assert.deepEqual(result.subarray(outputFrames.frames[0].end), tail);
  // The new header and unchanged event frames are validated together.
  for (const frame of scanned.frames.slice(1))
    check.write(await sdk.decompressZstdFrame(bytes.subarray(frame.start, frame.end)));
  const after = check.finish();
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.meta, { ...before.meta, cwd });
  return { bytes: result, identity: after.meta, oldIdentity: before.meta,
    bodySha256: sha256(tail), eventCount: before.events.length,
    eventsSha256: sha256(JSON.stringify(before.events)), frameCount: scanned.frames.length };
}
