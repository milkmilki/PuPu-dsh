import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesFiles, rewriteLinks } from '../src/engine/files.js';

test('paths cannot traverse, reach drives, devices, or escape through junctions', () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-paths-'));
  const files = new NotesFiles(join(root, 'notes'));
  for (const path of ['../secret', 'D:\\secret', '/secret', 'x/../../a', 'CON.md', 'x::$DATA'])
    assert.throws(() => files.absolute(path));
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(root, 'notes', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.absolute('escape/private.md'), /链接|联接/);
});

test('journal plans apply twice and refuse overwriting external content', () => {
  const files = new NotesFiles(mkdtempSync(join(tmpdir(), 'notes-plan-')));
  const plan = { changes: [{ path: '人物/小夫.md', before: null, after: '喜欢热茶。' }], createDirectories: [], deleteDirectories: [] };
  files.apply(plan); files.apply(plan);
  assert.equal(readFileSync(files.absolute('人物/小夫.md'), 'utf8'), '喜欢热茶。');
  assert.throws(() => files.apply({ ...plan, changes: [{ ...plan.changes[0]!, before: 'old', after: 'new' }] }), /之外/);
});

test('moves rewrite recognized Markdown links and preserve fenced code and external links', () => {
  const source = '[细节](经历/旅行.md#晚餐)\n[ref]: 经历/旅行.md\nhttps://example.com\n```\n[code](经历/旅行.md)\n```';
  const next = rewriteLinks(source, '目录.md', '目录.md', new Map([['经历/旅行.md', '往事/旅行.md']]));
  assert.match(next, /\[细节\]\(往事\/旅行.md#晚餐\)/);
  assert.match(next, /\[ref\]: 往事\/旅行.md/);
  assert.match(next, /\[code\]\(经历\/旅行.md\)/);
});
