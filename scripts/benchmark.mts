import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm';
import { NotesEngine } from '../src/engine/index.js';
import { notesSchema, notesToolSchema } from '../src/mcp/schema.js';
import { modelResult } from '../src/mcp/model-view.js';
import { invokeAdmin } from '../src/mcp/server.js';
import { TaskRunner, type Generate } from '../src/runner.js';
import type { EngineClient, Json, JsonObject, ModelRoute, Role } from '../src/contracts.js';

export const BENCHMARK_NOTES: Record<string, string> = {
  '角色.md': '# 璐璐\n\n你是璐璐，正在与小夫交谈。只根据找到的资料回答；没有资料就说不知道。\n',
  '目录.md': '# 记忆目录\n\n## 熟悉的人\n\n小夫的偏好和关系在人物目录；旅行及约定在经历目录。\n\n- [小夫](人物/小夫.md)\n- [同名的人](人物/两位小林.md)\n- [海边旅行](经历/海边旅行.md)\n- [约定](经历/约定.md)\n',
  '人物/小夫.md': '# 小夫\n\n小夫与璐璐是恋人。\n\n过去喜欢热茶。11月10日胃不舒服以后改喝温水，现在不要给他准备茶。\n',
  '人物/两位小林.md': '# 两位小林\n\n书店的小林住在松林街，养猫叫雪糕。\n\n乐队的小林住在河岸路，养狗叫豆包。两人是不同的人，不要合并。\n',
  '经历/海边旅行.md': '# 海边旅行\n\n10月8日，小夫和璐璐去青湾海边看日落。风大时，小夫把蓝色围巾围在璐璐脖子上。\n\n回程在灯塔旁的小店喝过桂花汽水。此后璐璐把那条蓝围巾放在床头柜里。\n',
  '经历/约定.md': '# 约定\n\n小夫答应11月23日陪璐璐去白鹭植物园看夜间花展，目前还没有履行。\n\n他们说好出发时带上青湾旅行的蓝围巾，不用带雨伞，因为已约好下雨就改期。\n',
  '随记/重复随笔.md': '# 看海的一天\n\n青湾旅行里，小夫为璐璐围过蓝围巾。细节在经历目录里。\n',
};
export interface BenchmarkQuestion {
  key: string; question: string; required: string[][]; forbidden: string[]; expectedPaths: string[];
}
export const BENCHMARK_QUESTIONS: BenchmarkQuestion[] = [
  { key: 'direct', question: '小夫和璐璐是什么关系？', required: [['恋人']], forbidden: ['普通朋友'], expectedPaths: ['人物/小夫.md'] },
  { key: 'paraphrase', question: '现在给小夫倒杯饮料，准备什么合适？', required: [['温水']], forbidden: ['准备热茶', '应该喝茶'], expectedPaths: ['人物/小夫.md'] },
  { key: 'vague', question: '上次风大，小夫给璐璐围上的那件东西，现在放在哪里？', required: [['蓝', '围巾'], ['床头柜']], forbidden: ['衣柜'], expectedPaths: ['经历/海边旅行.md'] },
  { key: 'cross-group', question: '下次花展该带上哪件旅行纪念物？它来自哪里？', required: [['蓝', '围巾'], ['青湾']], forbidden: ['雨伞'], expectedPaths: ['经历/约定.md', '经历/海边旅行.md'] },
  { key: 'changed-preference', question: '小夫还喜欢喝热茶吗？', required: [['温水'], ['过去', '以前', '原来', '现在不', '改']], forbidden: ['现在仍喜欢热茶', '还是热茶'], expectedPaths: ['人物/小夫.md'] },
  { key: 'same-name', question: '乐队的小林养的宠物叫什么？别和书店那位混了。', required: [['豆包']], forbidden: ['叫雪糕'], expectedPaths: ['人物/两位小林.md'] },
  { key: 'promise', question: '小夫还欠璐璐哪个约定，什么时候？', required: [['白鹭', '植物园'], ['23']], forbidden: ['已经履行'], expectedPaths: ['经历/约定.md'] },
  { key: 'not-found', question: '小夫的护照号码是多少？', required: [['不知道', '没有记录', '没有找到', '未记录', '不清楚', '没有相关']], forbidden: ['E12345678'], expectedPaths: [] },
];
export interface BenchmarkAnswer {
  key: string; question: string; answer: string; mode: 'tools' | 'full-context';
  stage: 'before' | 'after'; elapsedMs: number; requests: number;
  tools: { command: JsonObject; result: JsonObject }[];
  usage: Json[];
  rubric: { requiredGroups: boolean[]; forbiddenHits: string[]; expectedPathsRead: string[]; noAutomaticRecall: boolean };
}
export interface BenchmarkReport {
  kind: 'synthetic-memory-comparison';
  generatedAt: string;
  route: ModelRoute;
  modelQualityMeasured: boolean;
  limitation: string;
  questions: BenchmarkQuestion[];
  answers: BenchmarkAnswer[];
  maintenance: { status: string; beforePaths: string[]; afterPaths: string[]; progress: JsonObject };
}

/** Same material/questions, measured with provider calls supplied by DSH or a caller's adapter. */
export async function runMemoryBenchmark(generate: Generate, route: ModelRoute, options: {
  root?: string; modelQualityMeasured?: boolean;
} = {}): Promise<BenchmarkReport> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'pupu-benchmark-'));
  mkdirSync(root, { recursive: true });
  const engine = new NotesEngine(join(root, 'lulu'), { roleName: '璐璐' });
  const isolated = new NotesEngine(join(root, 'other'), { roleName: '仆仆' });
  for (const [path, content] of Object.entries(BENCHMARK_NOTES)) {
    const old = engine.files.maybeRead(path);
    if (old === null) await engine.execute({ action: 'create', path, content });
    else await engine.execute({ action: 'edit', path, oldText: old, newText: content });
  }
  await isolated.execute({ action: 'create', path: '随记/别人的事.md', content: '隔离角色的独有暗号是银铃葡萄。' });
  const role: Role = { id: 'benchmark-lulu', name: '璐璐', speakerName: '小夫', roleCardPath: '角色.md', lastModel: route, createdAt: new Date().toISOString() };
  const client: EngineClient = {
    notes: (command, context) => engine.execute(command, context),
    admin: async <T,>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) => await invokeAdmin(engine, method, args) as T,
    close: async () => {},
  };
  const answers: BenchmarkAnswer[] = [];
  const runQuestion = async (question: BenchmarkQuestion, mode: BenchmarkAnswer['mode'], stage: BenchmarkAnswer['stage']) => {
    const messages: Message[] = [createSystemMessage([
      engine.roleCard().content ?? '你是璐璐。',
      mode === 'tools' ? '需要记忆时主动使用 notes 工具。只根据找到的资料回答，没有找到就说明不知道。'
        : `下面是同一批完整笔记，请基于它回答。\n\n${Object.entries(BENCHMARK_NOTES).map(([path, text]) => `--- ${path} ---\n${text}`).join('\n\n')}`,
    ].join('\n\n')), createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: question.question }] })];
    const tools: BenchmarkAnswer['tools'] = [], usage: Json[] = [];
    const started = Date.now();
    let requests = 0, answer = '';
    // No cumulative loop bound. A provider request has the same 180s timeout as production.
    for (;;) {
      requests++;
      const output = await generate({ route, messages: [...messages], tools: mode === 'tools' ? [notesToolSchema] : [], signal: AbortSignal.timeout(180_000) });
      if (output.usage) usage.push(output.usage);
      const calls = output.message.content.filter(block => block.type === 'tool-call');
      if (output.finish === 'stop' && !calls.length) {
        answer = output.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        break;
      }
      if (output.finish !== 'tool-calls' || !calls.length || mode !== 'tools') throw new Error(`Benchmark request did not complete: ${output.finish}`);
      messages.push(output.message);
      for (const call of calls) {
        let result: JsonObject;
        try {
          if (call.name !== 'notes') throw new Error('Only notes is available');
          const command = notesSchema.parse(JSON.parse(call.arguments));
          if (!['view', 'search', 'sources'].includes(command.action)) throw new Error('Question evaluation permits read operations only');
          result = modelResult(await engine.execute(command, { actor: `benchmark:${stage}:${question.key}` }));
          tools.push({ command: command as unknown as JsonObject, result });
        } catch (error) { result = { error: String(error) }; }
        messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: JSON.stringify(result) }], isError: typeof result.error === 'string' }));
      }
    }
    answers.push({
      key: question.key, question: question.question, answer, mode, stage, elapsedMs: Date.now() - started, requests, tools, usage,
      rubric: {
        requiredGroups: question.required.map(alternatives => alternatives.some(term => answer.includes(term))),
        forbiddenHits: question.forbidden.filter(term => answer.includes(term)),
        expectedPathsRead: question.expectedPaths.filter(path => tools.some(tool => tool.command.action === 'view' && tool.command.path === path)),
        noAutomaticRecall: mode === 'tools' && !messages[0]!.content.some(block => block.type === 'text' && block.text.includes('小夫喜欢热茶')),
      },
    });
  };
  try {
    for (const question of BENCHMARK_QUESTIONS) {
      await runQuestion(question, 'tools', 'before');
      await runQuestion(question, 'full-context', 'before');
    }
    const beforePaths = engine.files.walk().map(file => file.path);
    const task = engine.registerDaily('2026-11-17');
    const runner = new TaskRunner(() => role, async () => client, generate);
    runner.wake(role.id); await runner.idle(); await runner.close();
    const maintenance = engine.getTask(task.id);
    if (maintenance.status !== 'completed') throw new Error(`Benchmark maintenance incomplete: ${maintenance.error ?? maintenance.status}`);
    for (const question of BENCHMARK_QUESTIONS) {
      await runQuestion(question, 'tools', 'after');
      await runQuestion(question, 'full-context', 'after');
    }
    if ((await engine.execute({ action: 'search', query: '银铃葡萄' })).total !== 0) throw new Error('Role isolation failed');
    return {
      kind: 'synthetic-memory-comparison', generatedAt: new Date().toISOString(), route,
      modelQualityMeasured: options.modelQualityMeasured ?? true,
      limitation: '旧版源码不可用，完整上下文是对照组，不代表旧版 RAG。对照组在整理前后都保留同一份初始完整资料，用于检查工具式笔记整理后的信息保留。关键词评分只提供初筛（否定句或对比同名人物也可能触发 forbidden），需人工查看回答、工具轨迹和来源。整理允许移动/合并笔记，因此整理后初始路径未命中不单独代表回忆失败。合成资料不包含真实私人记忆。',
      questions: BENCHMARK_QUESTIONS, answers,
      maintenance: { status: maintenance.status, beforePaths, afterPaths: engine.files.walk().map(file => file.path), progress: maintenance.progress },
    };
  } finally { engine.close(); isolated.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { adapter: { type: 'string' }, output: { type: 'string' }, root: { type: 'string' } } });
  if (!values.adapter) throw new Error('Usage: node --import tsx scripts/benchmark.mts --adapter <module exporting generate and route> [--output report.json]');
  const adapter = await import(pathToFileURL(resolve(values.adapter)).href) as { generate: Generate; route: ModelRoute };
  if (typeof adapter.generate !== 'function' || !adapter.route?.provider || !adapter.route?.model) throw new Error('Adapter must export generate and route');
  const report = await runMemoryBenchmark(adapter.generate, adapter.route, { root: values.root });
  const output = resolve(values.output ?? 'artifacts/benchmark.json');
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(output);
}
