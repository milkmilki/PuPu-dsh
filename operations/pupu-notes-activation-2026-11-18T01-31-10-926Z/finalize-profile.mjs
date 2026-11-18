import assert from 'node:assert/strict';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'C:/Users/57859/.dsh/profiles/web';
const backup = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129/operations/pupu-notes-activation-2026-11-18T01-31-10-926Z';
const installed = name => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
assert.equal(installed('dsh-pupu-notes').version, '0.1.2');
assert.equal(installed('dsh-qq').version, '0.1.6');
const path = join(root, 'package.json'), config = JSON.parse(readFileSync(path, 'utf8'));
assert(config.dependencies['dsh-pupu'], 'Keep the old package available for rollback');
assert(config.dsh.profile.bundles.includes('dsh-pupu-notes'));
assert(config.dsh.profile.bundles.includes('dsh-qq'));
config.dsh.profile.bundles = config.dsh.profile.bundles.filter(name => name !== 'dsh-pupu');
writeFileSync(`${path}.pupu-notes.tmp`, `${JSON.stringify(config, null, 2)}\n`);
renameSync(`${path}.pupu-notes.tmp`, path);
writeFileSync(join(backup, 'profile-after.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ oldBundleDisabled: true, oldPackagePreserved: true,
  activeBundles: config.dsh.profile.bundles.filter(name => /pupu|qq/.test(name)) }));
