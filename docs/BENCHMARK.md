# 记忆内容对照验证

`scripts/benchmark.mts` 使用合成笔记，不读取仆仆或璐璐的真实私人资料。

同一批资料覆盖八种提问：直接事实、换一种说法、模糊线索、跨卡片关联、偏好变化、同名人物、尚未履行的约定、资料不存在。每道题分别走主动工具查询和完整上下文对照，并在一次真实工具驱动的每日整理前后重复，共 32 个回答。

完整上下文对照在前后两轮都保留相同的初始完整资料，用于检查整理后工具式笔记是否仍能回答原问题。它不是已删除旧产品的 RAG 实现，也不证明新方式普遍更好。

## 运行

在本产品目录中：

```powershell
node --import tsx scripts/benchmark.mts --adapter D:\path\benchmark-adapter.mjs --output artifacts\benchmark.json
```

适配模块导出 `route: { provider, model }` 和 `generate(input)`。`generate` 遵循 `src/runner.ts` 的 `Generate` 类型，可复用 DSH Host 中的 `generateMemoryResponse(options => ctx.llm.stream(options), input)`。这样调用 DSH 已配置的提供方，不需要把凭据写进项目。也可以直接从 DSH Host 中导入并调用 `runMemoryBenchmark(generate, route)`。

报告保存回答原文、工具参数及结果、读取过的证据路径、每次调用用量、耗时、整理前后的文件清单和真实阅读覆盖。整理允许改名、合并和移动，所以整理后未读取原路径不能单独判定回忆失败。

## 已运行的验证

真实模型报告保存在交付产物的 `benchmark-real.json`，人工复核补充保存在 `benchmark-manual-assessment.json`。原始关键词评分保留为 **30/32**。两个命中来自否定句中的“雨伞”和区分同名人物时提到另一人的宠物；原始评分没有被改写。

人工复核确认这两个回答的回忆内容正确，同时保留一个措辞问题：模型在只读查询中说“我已分开记录”，容易让人误以为刚执行了写入。工具轨迹显示它读取了已经区分好的资料。读写状态必须以工具返回为准。

`tests/benchmark.test.ts` 使用脚本化回答，只验证测试框架、资料范围和证据轨迹；其 `modelQualityMeasured` 固定为 `false`，不能当成模型质量证据。
