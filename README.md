# 蒲蒲笔记（dsh-pupu-notes）

蒲蒲笔记是给 DeepSeek Harness 使用的独立角色笔记插件。它把长期记忆保存成角色目录里的 Markdown 笔记，让角色在需要时通过 `pupu_notes` 工具搜索、阅读、编辑和整理。系统只固定载入角色卡、双方姓名和最少的工具说明；不会把整座笔记库自动塞入每一轮上下文，也不使用向量数据库或 embedding。

每个角色有独立的笔记目录和 SQLite 来源库。默认整理模型沿用该角色最近一次 DSH 对话所使用的模型，也可以在“角色与对话”页指定另一条已配置的 Provider/模型路由。模型凭据仍由 DSH 管理。整理请求使用真正的多轮工具调用，每次 Provider 请求最多等待 180 秒；没有累计轮数或总耗时上限，用户可以在界面停止或重试。

## 当前实现

- DSH Web 原生设置页：角色、说话者、新建会话、角色卡、目录和 Markdown 编辑器。
- DSH 身份段落的角色级替换：角色卡在下一轮对话生效，保留工具、工作目录、权限和 Provider 路由。
- 独立 stdio MCP：`pupu-notes-mcp --root <角色目录>`，工具名 `notes`。
- DSH 会话工具：`pupu_notes`，只暴露当前绑定角色的 `view/search/create/edit/move/delete/sources`。
- DSH `compaction/start` 与手动整理触发独立后台记忆任务；原始对话只保留真实可见的人类输入、助手文本和附件引用。
- 每日 03:00 后在宿主运行期间执行整理；启动时补查当天遗漏任务。任务状态、覆盖范围、错误和可重试轨迹都可查看。
- 旧 PuPu SQLite / `.pupumem` 复制导入和 `.pupunotes` 数据包的预检、显式人物映射、精选种子包/完整迁移包。

角色记忆从“角色卡 + 人物/经历/随记”起步，但这些目录只是初始组织。模型可以在笔记工具允许的角色目录内自由创建、编辑、移动、合并、拆分和删除 Markdown；删除后版本仍可从历史页恢复。SQLite 保存原始对话、来源、版本、审计和任务恢复信息，不另建一套可写的 facts/events 真相库。

## 开发

项目需要 Node.js 24、DSH 0.2.1-rc.2 的运行环境。安装依赖后运行：

```powershell
npm install
npm run check
npm run pack:local
```

`artifacts/` 中的 `.tgz` 是本地安装产物。当前版本不自动发布 npm 或 GitHub，也不在软件包中附带真实私人记忆。

## 数据和并行安装

新产品使用 DSH 数据目录下独立的 `pupu-notes` 根目录，与旧版 `pupu-dsh` 并行。导入是复制流程：预检会展示角色、人物、计数、版本和建议路径；确认后才建立新角色库。重复来源按内容指纹识别，只把变化资料放入“导入补充”，不会覆盖已经由 AI 整理过的笔记。旧插件、旧会话和旧数据不会被接管或删除。

完整安装、卸载和回滚步骤见 [docs/INSTALL.md](docs/INSTALL.md)。当前可验证范围与未完成的真实 DSH 验收见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)。
