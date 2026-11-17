import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { strFromU8 } from 'fflate';
import { Catalog } from './catalog.js';
import type { ImportPreview, ImportSelection, Role } from './contracts.js';
import { readLegacySnapshot, legacyDialoguePlan, legacySourceIdentity, projectLegacy, referenceWarnings } from './migration/legacy.js';
import { copyRole, ensurePlainDirectory, fingerprints, hash, readZip, removeStage, type Projection, type Snapshot } from './migration/shared.js';
import { exportPackage, inspectNotesPackage, packageNoteRecords, packageSnapshot, restoreState } from './migration/package.js';
import { openArchive, addReferences, appendRecords, archiveCoverage, restoreArchive } from './migration/archive.js';
import { activateRole, recoverActivations } from './migration/activation.js';
import { NotesEngine } from './engine/index.js';
interface PreviewState { source: string; sourceKey: string; snapshot: Snapshot; preview: ImportPreview; persona: string; roleCardPath: string; package?: ReturnType<typeof packageSnapshot>; }
export { exportPackage, inspectNotesPackage };
export class MigrationService {
  private previews = new Map<string, PreviewState>();
  constructor(private readonly catalog: Catalog) { recoverActivations(catalog); }
  targetRoleId(token: string): string | undefined { const record = this.previews.get(token); return record ? this.catalog.importRecord(record.sourceKey)?.roleId : undefined; }
  source(token: string): string | undefined { return this.previews.get(token)?.source; }
  async preview(path: string): Promise<ImportPreview> {
    const source = resolve(path);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error('请选择一个旧记忆数据库、.pupumem 或 .pupunotes 文件');
    let name = basename(dirname(source)), snapshot: Snapshot, packageInfo: ReturnType<typeof packageSnapshot> | undefined, sourceKey: string, persona = '', roleCardPath = '角色.md';
    if (source.toLowerCase().endsWith('.pupumem')) {
      const entries = readZip(source);
      const manifest = JSON.parse(strFromU8(entries['manifest.json'] ?? new Uint8Array())) as {
        format?: string; version?: number; character?: { name?: string; persona?: string };
        name?: string; persona?: string;
      };
      if (manifest.format !== 'pupu-memory' || manifest.version !== 1 || !entries['memory.sqlite']) throw new Error('不支持的旧记忆包版本');
      const stage = join(this.catalog.root, '.staging', `preview-${randomUUID()}`); ensurePlainDirectory(stage); const dbPath = join(stage, 'memory.sqlite'); writeFileSync(dbPath, entries['memory.sqlite'], { flag: 'wx' });
      try { snapshot = readLegacySnapshot(dbPath); } finally { removeStage(join(this.catalog.root, '.staging'), stage); }
      name = manifest.character?.name || manifest.name || name;
      const importedPersona = manifest.character?.persona ?? manifest.persona;
      if (typeof importedPersona === 'string') persona = importedPersona;
      sourceKey = legacySourceIdentity(source, snapshot);
    } else if (source.toLowerCase().endsWith('.pupunotes')) {
      const inspected = inspectNotesPackage(source);
      const stage = join(this.catalog.root, '.staging', `package-${randomUUID()}`); ensurePlainDirectory(stage);
      try { packageInfo = packageSnapshot(inspected.entries, stage); } finally { removeStage(join(this.catalog.root, '.staging'), stage); }
      snapshot = packageInfo.snapshot; name = inspected.manifest.role.name; roleCardPath = inspected.manifest.role.roleCardPath;
      sourceKey = `notes-role:${hash(inspected.manifest.role.id)}`;
    } else {
      snapshot = readLegacySnapshot(source); sourceKey = legacySourceIdentity(source, snapshot);
      const adjacent = join(dirname(dirname(dirname(source))), 'catalog.json');
      if (existsSync(adjacent)) {
        const catalogData = JSON.parse(readFileSync(adjacent, 'utf8')) as { roles?: { id?: string; name?: string; persona?: string }[] | Record<string, { id?: string; name?: string; persona?: string }> };
        const oldRoles = Array.isArray(catalogData.roles) ? catalogData.roles : Object.values(catalogData.roles ?? {});
        const originalId = basename(dirname(source));
        const original = oldRoles.find(role => role.id === originalId);
        if (typeof original?.name === 'string') name = original.name;
        if (typeof original?.persona === 'string') persona = original.persona;
      }
    }
    const counts = Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));
    const fp = fingerprints(snapshot);
    const people = (snapshot.people ?? []).map(row => ({ key: String(row.person_key), name: String(row.display_name || '未命名人物') }));
    const proposedPaths = packageInfo ? (snapshot.notes ?? []).map(row => String(row.path)) : [...projectLegacy(snapshot, {}, name).keys()];
    const warnings = packageInfo ? [] : referenceWarnings(snapshot);
    if (this.catalog.importRecord(sourceKey)) warnings.push('此来源已导入：本次只添加变化资料，不覆盖现有笔记。');
    if (!packageInfo) {
      const safeSessions = legacyDialoguePlan(snapshot, sourceKey).cursors;
      const unproven = [...(snapshot.messages ?? []), ...(snapshot.archived_messages ?? [])]
        .filter(row => !safeSessions.has(String(row.session_id))).length;
      if (unproven) warnings.push(`${unproven} 条历史对话没有可证明的处理游标：保留为原始来源，不自动重新整理。`);
    }
    const token = randomUUID(), preview: ImportPreview = { token, name, people, counts, fingerprints: fp, warnings, proposedPaths }; this.previews.set(token, { source, sourceKey, snapshot, preview, persona, roleCardPath, package: packageInfo }); return preview;
  }
  async confirm(selection: ImportSelection): Promise<{ role: Role; counts: Record<string, number>; changed: number }> {
    if (!selection.confirmed) throw new Error('需要在预检后明确确认复制导入');
    const state = this.previews.get(selection.token);
    if (!state) throw new Error('预检已失效，请重新选择来源');
    if (!selection.name.trim() || !selection.speakerName.trim()) throw new Error('请填写角色与说话者名称');
    const previous = this.catalog.importRecord(state.sourceKey);
    const previousData = previous?.data as { personMapping?: Record<string, string>; fingerprints?: Record<string, string> } | undefined;
    const mapping = { ...previousData?.personMapping, ...selection.personMapping };
    const expected = new Set(state.preview.people.map(person => person.key));
    for (const key of expected) if (!mapping[key]?.trim()) throw new Error(`请明确映射人物：${key}`);
    for (const key of Object.keys(mapping)) if (!expected.has(key)) throw new Error('人物映射不属于此来源');
    if (previous && JSON.stringify(previousData?.fingerprints) === JSON.stringify(state.preview.fingerprints)) {
      this.previews.delete(selection.token);
      return { role: this.catalog.role(previous.roleId), counts: state.preview.counts, changed: 0 };
    }
    const role: Role = previous ? this.catalog.role(previous.roleId) : {
      id: randomUUID(), name: selection.name.trim(), speakerName: selection.speakerName.trim(),
      roleCardPath: state.roleCardPath, createdAt: new Date().toISOString(),
    };
    const stageRoot = join(this.catalog.root, '.staging'), stage = join(stageRoot, `import-${randomUUID()}`);
    ensurePlainDirectory(stage);
    const notesRoot = join(stage, 'notes');
    let projected: Map<string, Projection>;
    if (state.package) projected = new Map((state.snapshot.notes ?? []).map(row => [
      String(row.path), { content: String(row.content), records: packageNoteRecords(
        state.snapshot, state.package!.state, state.package!.archive, String(row.path),
      ) },
    ]));
    else projected = projectLegacy(state.snapshot, mapping, role.name, state.persona);
    let changed = 0, prepared = false;
    try {
      if (previous) await copyRole(this.catalog.rootFor(role.id), stage);
      ensurePlainDirectory(notesRoot);
      const archive = openArchive(stage);
      let coverage: ReturnType<typeof archiveCoverage>;
      try {
        archive.exec('BEGIN IMMEDIATE');
        const changedKeys = appendRecords(archive, state.sourceKey, state.snapshot);
        changed = changedKeys.size;
        if (!previous && state.package) restoreArchive(archive, state.package.archive);
        const prefix = previous ? `导入补充/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}/` : '';
        for (const [path, note] of projected) {
          if (previous && !note.records.some(record => changedKeys.has(`${record.table}:${record.key}`))) continue;
          const targetPath = `${prefix}${path}`, target = join(notesRoot, targetPath);
          ensurePlainDirectory(dirname(target));
          writeFileSync(target, note.content, { flag: 'wx' });
          addReferences(archive, targetPath, state.sourceKey, note);
        }
        coverage = archiveCoverage(archive, state.sourceKey, state.snapshot);
        archive.prepare('INSERT OR REPLACE INTO imports VALUES(?,?)').run(state.sourceKey, JSON.stringify({
          counts: state.preview.counts, fingerprints: state.preview.fingerprints, personMapping: mapping, coverage,
        }));
        archive.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) { try { archive.exec('ROLLBACK'); } catch {} throw error; }
      finally { archive.close(); }
      if (!previous && state.package) restoreState(stage, state.package.state, role);
      for (const dir of ['人物', '经历', '随记']) ensurePlainDirectory(join(notesRoot, dir));
      const engine = new NotesEngine(stage, { roleName: role.name, roleCardPath: role.roleCardPath });
      try {
        for (const row of state.snapshot.notes_history ?? []) {
          const content = String(row.data), sourceKey = `history:${state.sourceKey}:${hash(content)}`;
          engine.db.prepare('INSERT OR IGNORE INTO source_documents VALUES(?,?,?,?)')
            .run(sourceKey, 'imported-history', content, JSON.stringify({ source: state.sourceKey }));
        }
        if (!state.package) {
          const plan = legacyDialoguePlan(state.snapshot, state.sourceKey);
          const upper = new Map<string, number>(), processed = new Map<string, number>();
          for (const row of plan.messages) {
            const sessionId = plan.session(String(row.session_id)), oldId = Number(row.id);
            const result = engine.captureDialogue({
              sessionId, messageId: `legacy:${oldId}`, party: row.role === 'assistant' ? 'assistant' : 'human',
              speaker: String(row.speaker_name || mapping[String(row.speaker_key)] || (row.role === 'assistant' ? role.name : role.speakerName)),
              text: String(row.content), attachments: plan.attachments(row), at: String(row.timestamp),
            });
            upper.set(sessionId, Math.max(upper.get(sessionId) ?? 0, result.seq));
            if (oldId <= plan.cursors.get(String(row.session_id))!)
              processed.set(sessionId, Math.max(processed.get(sessionId) ?? 0, result.seq));
          }
          for (const [sessionId, seq] of processed) engine.db.prepare(
            'INSERT INTO cursors VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET seq=MAX(seq,excluded.seq)',
          ).run(sessionId, seq);
          for (const [sessionId, seq] of upper) engine.registerTrigger({
            triggerId: `import:${state.sourceKey}:${sessionId}:${seq}`, sessionId, upperBound: seq, reason: 'import',
          });
        }
        engine.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { engine.close(); }
      const importData = {
        counts: state.preview.counts, fingerprints: state.preview.fingerprints,
        personMapping: mapping, source: state.source, coverage,
      };
      prepared = true;
      activateRole(this.catalog, role, stage, state.sourceKey, importData);
      this.previews.delete(selection.token);
      return { role, counts: state.preview.counts, changed };
    } catch (error) {
      // Once journaled, leave the prepared stage for deterministic roll-forward.
      if (!prepared) removeStage(stageRoot, stage);
      throw error;
    }
  }
  inspect(token: string): ImportPreview { const state = this.previews.get(token); if (!state) throw new Error('预检已失效'); return state.preview; }
}
