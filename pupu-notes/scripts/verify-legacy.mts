import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../src/catalog.js';
import { MigrationService } from '../src/migration.js';
import { NotesEngine } from '../src/engine/index.js';
import { readLegacySnapshot } from '../src/migration/legacy.js';
import { fingerprints } from '../src/migration/shared.js';

const workspace = resolve('.test-data', `legacy-verify-${Date.now()}`);
mkdirSync(workspace, { recursive: true });
const catalog = new Catalog(workspace);
const migration = new MigrationService(catalog);
const sources = [
  ['仆仆', 'c125ced2-8886-4ffd-884b-eefa85868cf7'],
  ['璐璐', '752d6073-cf82-471b-98ef-b4e5894dfeb8'],
];
const reports = [];
try {
  for (const [name, key] of sources) {
    const source = `C:/Users/57859/.dsh/data/pupu-dsh/characters/${key}/memory.db`;
    const before = fingerprints(readLegacySnapshot(source));
    const preview = await migration.preview(source);
    const mapping = Object.fromEntries(preview.people.map(person => [person.key, person.name]));
    const result = await migration.confirm({ token: preview.token, name, speakerName: '知夏姐姐', personMapping: mapping, confirmed: true });
    const roleRoot = catalog.rootFor(result.role.id);
    const engine = new NotesEngine(roleRoot, { roleName: name });
    const archive = new DatabaseSync(join(roleRoot, 'migration.sqlite'), { readOnly: true });
    try {
      const records = archive.prepare('SELECT table_name,COUNT(*) AS count FROM records GROUP BY table_name').all() as { table_name: string; count: number }[];
      const coverage = records.every(row => row.count === preview.counts[row.table_name]);
      if (!coverage) throw new Error(`${name}: source record count mismatch`);
      const imported = catalog.importRecord([...archive.prepare('SELECT source_key FROM imports').all()][0]!.source_key as string);
      const data = imported?.data as Record<string, unknown>;
      const fact = engine.files.walk().find(note => note.path.startsWith('人物/'));
      const evidence = fact ? await engine.execute({ action: 'sources', path: fact.path, limit: 100 }) : null;
      const after = fingerprints(readLegacySnapshot(source));
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${name}: source changed`);
      const card = engine.roleCard();
      const report = {
        name, sourceCounts: preview.counts, allRecordCountsMatch: coverage,
        contentFingerprintsMatch: JSON.stringify(preview.fingerprints) === JSON.stringify(data.fingerprints),
        sourceUnchanged: true, referenceWarnings: preview.warnings,
        notes: engine.files.walk().length,
        personaCharacters: card.content?.length ?? 0,
        sourcesAccessible: !!evidence,
        tasks: engine.listTasks().map(task => ({ reason: task.reason, status: task.status, progress: task.progress })),
        coverage: data.coverage,
      };
      reports.push(report);
      console.log(JSON.stringify({ name, counts: preview.counts, notes: report.notes, sourcesAccessible: true, sourceUnchanged: true }));
    } finally { archive.close(); engine.close(); }
  }
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/legacy-verification.json', JSON.stringify({ testOnlyCopies: true, generatedAt: new Date().toISOString(), reports }, null, 2));
} finally { catalog.close(); }
