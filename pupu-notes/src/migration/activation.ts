import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Catalog } from '../catalog.js';
import type { Role } from '../contracts.js';
import { atomicJson, ensurePlainDirectory, removeStage, within } from './shared.js';

interface Activation {
  id: string; role: Role; sourceKey: string; importData: unknown;
  stage: string; destination: string; backup: string; journal: string;
}
/** Roll forward a prepared role swap after a process crash. All paths are ours. */
export function recoverActivations(catalog: Catalog): void {
  const journalRoot = join(catalog.root, '.import-journals');
  ensurePlainDirectory(journalRoot);
  for (const name of readdirSync(journalRoot).filter(value => value.endsWith('.json'))) {
    const journal = join(journalRoot, name);
    const activation = JSON.parse(readFileSync(journal, 'utf8')) as Activation;
    if (!activation || typeof activation.id !== 'string' || !activation.role ||
      activation.journal !== journal || activation.destination !== join(catalog.root, 'roles', activation.role.id))
      throw new Error('导入恢复日志格式无效');
    for (const path of [activation.stage, activation.backup]) within(join(catalog.root, '.staging'), path);
    applyActivation(catalog, activation);
  }
}
function applyActivation(catalog: Catalog, activation: Activation): void {
  const { stage, destination, backup, role } = activation;
  if (existsSync(stage)) {
    if (existsSync(destination)) {
      if (existsSync(backup)) throw new Error('导入恢复发现重复目标，请保留现场检查');
      renameSync(destination, backup);
    }
    renameSync(stage, destination);
  }
  if (!existsSync(destination)) {
    if (existsSync(backup)) renameSync(backup, destination);
    throw new Error('导入暂存目录缺失，已恢复原角色库');
  }
  catalog.db.exec('BEGIN IMMEDIATE');
  try {
    catalog.db.prepare('INSERT INTO roles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(role.id, JSON.stringify(role));
    catalog.saveImport(activation.sourceKey, role.id, activation.importData);
    catalog.db.exec('COMMIT');
  } catch (error) { catalog.db.exec('ROLLBACK'); throw error; }
  // Backups are deliberately retained under .staging until the journal is committed.
  removeStage(join(catalog.root, '.staging'), backup);
  const journalRoot = join(catalog.root, '.import-journals');
  within(journalRoot, activation.journal);
  unlinkSync(activation.journal);
}

export function activateRole(
  catalog: Catalog, role: Role, stage: string, sourceKey: string, importData: unknown,
): void {
  const id = randomUUID(), journalRoot = join(catalog.root, '.import-journals');
  ensurePlainDirectory(journalRoot);
  const activation: Activation = {
    id, role, stage, sourceKey, importData,
    destination: join(catalog.root, 'roles', role.id),
    backup: join(catalog.root, '.staging', `backup-${id}`),
    journal: join(journalRoot, `${id}.json`),
  };
  within(join(catalog.root, '.staging'), stage);
  atomicJson(activation.journal, activation);
  applyActivation(catalog, activation);
}
