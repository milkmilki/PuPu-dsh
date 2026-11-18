import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { JsonObject } from '../src/contracts.js';
import { runMemoryBenchmark, BENCHMARK_QUESTIONS } from '../scripts/benchmark.mjs';
import type { Generate } from '../src/runner.js';

test('benchmark compares same questions before/after real read coverage without treating scripted answers as model quality', async () => {
  let calls = 0;
  const fixtureAnswers: Record<string, string> = {
    direct: '小夫与璐璐是恋人。',
    paraphrase: '准备温水。',
    vague: '蓝围巾放在床头柜。',
    'cross-group': '带上青湾旅行的蓝围巾。',
    'changed-preference': '过去喝热茶，现在改喝温水。',
    'same-name': '乐队的小林养狗豆包。',
    promise: '11月23日去白鹭植物园。',
    'not-found': '没有记录，不知道。',
  };
  const generate: Generate = async input => {
    calls++;
    const tool = (command: JsonObject) => ({
      finish: 'tool-calls' as const, message: createAssistantMessage({
        source: { provider: 'fixture', model: 'deterministic' },
        content: [{ type: 'tool-call', id: ToolCallId(`fixture-${calls}`), name: 'notes', arguments: JSON.stringify(command) }],
      }),
    });
    const user = input.messages.find(message => message.role === 'user')!;
    const userText = user.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const results = input.messages.filter(message => message.role === 'tool');
    if (userText.includes('完整笔记整理')) {
      if (results.length === 0) return tool({ action: 'view' });
      const root = JSON.parse(results[0]!.content.filter(block => block.type === 'text').map(block => block.text).join('')) as { entries: { path: string; kind: string }[] };
      // A scripted traversal verifies the engine's real read manifest and tool handling.
      const paths = ['角色.md', '目录.md', '人物/小夫.md', '人物/两位小林.md', '经历/海边旅行.md', '经历/约定.md', '随记/重复随笔.md'];
      if (results.length <= paths.length) return tool({ action: 'view', path: paths[results.length - 1]! });
    } else {
      const question = BENCHMARK_QUESTIONS.find(item => item.question === userText)!;
      if (input.tools.length && results.length < question.expectedPaths.length)
        return tool({ action: 'view', path: question.expectedPaths[results.length]! });
      return { finish: 'stop', message: createAssistantMessage({ source: { provider: 'fixture', model: 'deterministic' }, content: [{ type: 'text', text: fixtureAnswers[question.key]! }] }) };
    }
    return { finish: 'stop', message: createAssistantMessage({ source: { provider: 'fixture', model: 'deterministic' }, content: [{ type: 'text', text: '全部读完，无需修改。' }] }) };
  };
  const report = await runMemoryBenchmark(generate, { provider: 'fixture', model: 'deterministic' }, { modelQualityMeasured: false });
  assert.equal(report.answers.length, 32);
  assert.equal(report.modelQualityMeasured, false);
  assert.equal(report.maintenance.status, 'completed');
  assert.equal(report.maintenance.progress.readFiles, 7);
  for (const answer of report.answers) {
    assert.equal(answer.rubric.requiredGroups.every(Boolean), true);
    assert.deepEqual(answer.rubric.forbiddenHits, []);
    if (answer.mode === 'tools') {
      assert.equal(answer.rubric.noAutomaticRecall, true);
      assert.deepEqual(answer.rubric.expectedPathsRead, BENCHMARK_QUESTIONS.find(question => question.key === answer.key)!.expectedPaths);
    }
  }
});
