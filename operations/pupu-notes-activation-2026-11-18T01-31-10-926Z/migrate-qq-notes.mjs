import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const backupRoot = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129/operations/pupu-notes-activation-2026-11-18T01-31-10-926Z';
const livePath = 'C:/Users/57859/.dsh/data/dsh-qq/bridge.db';
const notesPath = 'C:/Users/57859/.dsh/data/pupu-notes/catalog.sqlite';
const oldCatalogPath = 'C:/Users/57859/.dsh/data/pupu-dsh/catalog.json';
const markerKey = 'pupu-notes-migration:v1';
const applied = process.argv[2] === 'apply';
assert(applied || process.argv[2] === 'dry-run', 'Choose dry-run or apply explicitly');
const sha = text => createHash('sha256').update(text).digest('hex');
const oldCatalogBytes = readFileSync(oldCatalogPath);
const oldCatalog = JSON.parse(oldCatalogBytes.toString('utf8'));
const notes = new DatabaseSync(notesPath, { readOnly: true });
const roles = new Map(notes.prepare('SELECT id,data FROM roles').all().map(row => [row.id, JSON.parse(row.data)]));
const mapping = new Map();
for (const row of notes.prepare('SELECT role_id,data FROM imports').all()) {
  const imported = JSON.parse(row.data);
  const source = win32.normalize(String(imported.source ?? ''));
  const sourceRoot = win32.normalize('C:/Users/57859/.dsh/data/pupu-dsh/characters');
  assert(source.toLowerCase().startsWith(`${sourceRoot.toLowerCase()}\\`), 'Unexpected source root');
  assert.equal(win32.basename(source), 'memory.db');
  const oldRoleId = win32.basename(win32.dirname(source));
  assert.equal(win32.dirname(win32.dirname(source)).toLowerCase(), sourceRoot.toLowerCase());
  const oldRole = oldCatalog.roles.find(role => role.id === oldRoleId);
  const newRole = roles.get(row.role_id);
  assert(oldRole && newRole, 'An imported role has no authoritative source');
  assert.equal(oldRole.name, newRole.name);
  assert.equal(imported.personMapping.owner, newRole.speakerName);
  assert(!mapping.has(oldRoleId), 'Ambiguous imported role source');
  mapping.set(oldRoleId, { newRoleId: row.role_id, name: newRole.name, owner: imported.personMapping.owner });
}
notes.close();
assert.equal(mapping.size, 2);
if (applied) {
  const lockPath = 'C:/Users/57859/.dsh/data/dsh-qq/bridge.lock';
  if (existsSync(lockPath)) {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      assert(!alive, 'Stop the QQ bridge before migration');
    }
  }
}
const databasePath = applied ? livePath : join(backupRoot, 'qq-migration-dry-run-v2.db');
if (!applied && !existsSync(databasePath)) {
  const source = new DatabaseSync(livePath, { readOnly: true });
  try { await backup(source, databasePath); } finally { source.close(); }
}
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
function fingerprint(table) {
  const canonical = row => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])));
  return sha(db.prepare(`SELECT * FROM "${table}"`).all().map(canonical).sort().join('\n'));
}
const protectedTables = ['inbox', 'outbox', 'contacts', 'input_batches', 'input_batch_members'];
db.exec('BEGIN IMMEDIATE');
const before = Object.fromEntries(protectedTables.map(table => [table, fingerprint(table)]));
try {
  const previous = db.prepare('SELECT value FROM settings WHERE key=?').get(markerKey);
  if (previous) {
    const report = JSON.parse(previous.value);
    for (const table of protectedTables) assert.equal(fingerprint(table), report.protectedTables[table]);
    db.exec('COMMIT');
    writeFileSync(join(backupRoot, applied ? 'qq-migration-report.json' : 'qq-migration-dry-run-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ applied, alreadyMigrated: true, roles: report.roles.map(role => role.name) }));
  } else {
    const configRow = db.prepare("SELECT value FROM settings WHERE key='config'").get();
    assert(configRow);
    const config = JSON.parse(configRow.value);
    const originalRoutes = db.prepare('SELECT * FROM routes ORDER BY account,peer').all();
    assert.equal(originalRoutes.length, 2, 'Inspect unexpected route changes before continuing');
    const unknownPending = db.prepare("SELECT COUNT(*) AS n FROM input_batches WHERE status!='accepted'").get().n;
    assert.equal(unknownPending, 0, 'Pending sealed batches must remain on their original native sessions');
    const eligible = db.prepare(`SELECT COUNT(*) AS n FROM inbox i JOIN contacts c
      ON c.account=i.account AND c.peer=i.peer WHERE i.status='received' AND c.status='approved'`).get().n;
    assert.equal(eligible, 0, 'New eligible input arrived; recheck migration boundaries');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status!='sent'").get().n, 0);
    const transitions = [];
    try {
      const setting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
      for (const speaker of oldCatalog.speakers ?? []) {
        const key = `speaker-name:${speaker.personKey}`;
        const known = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
        if (known) assert.equal(JSON.parse(known.value), speaker.name, 'Speaker identity changed');
        else setting.run(key, JSON.stringify(speaker.name));
      }
      for (const account of config.accounts) {
        if (!account.roleId) continue;
        const target = mapping.get(account.roleId);
        assert(target, 'QQ account references a role without a verified imported copy');
        account.roleId = target.newRoleId;
      }
      db.prepare("UPDATE settings SET value=? WHERE key='config'").run(JSON.stringify(config));
      for (const stored of originalRoutes) {
        const old = JSON.parse(stored.value);
        assert.equal(stored.session, old.sessionId);
        const target = mapping.get(old.roleId);
        assert(target);
        const originalBinding = oldCatalog.bindings[old.sessionId];
        assert.equal(originalBinding?.roleId, old.roleId, 'Old native session role does not match QQ route');
        const speakerKey = old.speakerKey || 'owner';
        assert.equal(originalBinding.speakerKey || 'owner', speakerKey);
        const speakerName = speakerKey === 'owner' ? target.owner
          : oldCatalog.speakers?.find(person => person.personKey === speakerKey)?.name;
        assert(speakerName, 'No authoritative speaker name');
        const account = config.accounts.find(account => account.id === old.account);
        assert(account && account.roleId === target.newRoleId && account.workspaceId === old.workspaceId);
        assert.equal(db.prepare('SELECT status FROM contacts WHERE account=? AND peer=?').get(old.account, old.peer)?.status, 'approved');
        const historyKey = `route-history:${old.sessionId}`;
        const history = db.prepare('SELECT value FROM settings WHERE key=?').get(historyKey);
        if (history) assert.equal(history.value, stored.value, 'Conflicting route history');
        else setting.run(historyKey, stored.value);
        const route = { ...old, roleId: target.newRoleId, sessionId: randomUUID(),
          speakerKey, speakerName, status: 'creating', watermark: -1 };
        delete route.error;
        db.prepare('UPDATE routes SET session=?,value=? WHERE account=? AND peer=?')
          .run(route.sessionId, JSON.stringify(route), old.account, old.peer);
        transitions.push({ name: target.name, oldSessionId: old.sessionId, newSessionId: route.sessionId,
          newRoleId: route.roleId, speakerName, workspaceId: route.workspaceId });
      }
      for (const table of protectedTables) assert.equal(fingerprint(table), before[table], `${table} changed`);
      const report = { migratedAt: new Date().toISOString(), roles: transitions,
        protectedTables: before, sourceCatalogSha256: sha(oldCatalogBytes), preservedNativeSessions: true };
      setting.run(markerKey, JSON.stringify(report));
      db.exec('COMMIT');
      assert.equal(sha(readFileSync(oldCatalogPath)), report.sourceCatalogSha256);
      writeFileSync(join(backupRoot, applied ? 'qq-migration-report.json' : 'qq-migration-dry-run-report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ applied, roles: transitions.map(role => ({ name: role.name, speakerName: role.speakerName })),
        protectedDataUnchanged: true, preservedHistoryRoutes: transitions.length }));
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
} finally { db.close(); }
