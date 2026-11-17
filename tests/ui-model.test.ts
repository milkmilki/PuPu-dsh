import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownLink, readDocument } from '../src/ui/view-model.js';

test('editor reads every page without omitting final newline or accepting mixed revisions', async () => {
  const calls: number[] = [];
  const doc = await readDocument(async request => {
    calls.push(request.input?.startLine as number);
    return request.input?.startLine === 1
      ? { kind: 'file', content: '第一行\n第二行', revision: 'r1', nextStartLine: 3 }
      : { kind: 'file', content: '最后一行\n', revision: 'r1', nextStartLine: null };
  }, 'role', '经历/秋天.md');
  assert.equal(doc.content, '第一行\n第二行\n最后一行\n');
  assert.deepEqual(calls, [1, 3]);
  await assert.rejects(readDocument(async request => ({
    kind: 'file', content: 'changed', revision: request.input?.startLine === 1 ? 'r1' : 'r2',
    nextStartLine: request.input?.startLine === 1 ? 2 : null,
  }), 'role', '角色.md'), /发生了变化/);
});

test('notebook links cannot invoke scripts, navigate disk or escape their role', () => {
  assert.equal(markdownLink('javascript:alert(1)', '人物/小夫.md'), null);
  assert.equal(markdownLink('file:///C:/secret', '人物/小夫.md'), null);
  assert.equal(markdownLink('../../别的角色.md', '人物/小夫.md'), null);
  assert.equal(markdownLink('/目录.md', '人物/小夫.md'), null);
  assert.deepEqual(markdownLink('../经历/秋天.md#约定', '人物/小夫.md'), { kind: 'note', target: '经历/秋天.md' });
  assert.deepEqual(markdownLink('人物/', '目录.md'), { kind: 'note', target: '人物' });
  assert.deepEqual(markdownLink('https://example.org', '目录.md'), { kind: 'web', target: 'https://example.org' });
});

test('non-progressing host pagination is surfaced instead of looping', async () => {
  await assert.rejects(readDocument(async () => ({
    kind: 'file', content: 'x', revision: 'r1', nextStartLine: 1,
  }), 'role', '目录.md'), /没有前进/);
});
