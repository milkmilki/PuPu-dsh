# PuPu DSH

给 DeepSeek Harness 使用的角色笔记与 QQ 接入插件源码。

| 目录 | 内容 | 当前版本 |
| --- | --- | --- |
| [pupu-notes](pupu-notes/README.md) | Markdown 角色笔记、独立 MCP、角色与说话者选择、后台整理及旧库复制导入 | 0.1.2 |
| [dsh-qq-notes](dsh-qq-notes/README.md) | QQ 私聊桥接，将原生 DSH 会话绑定到笔记角色 | 0.1.6 |
| [operations](operations/README.md) | 本机启动器、迁移工具、合成测试与恢复说明 | 操作源码 |

两个插件保留各自的依赖、锁文件、构建入口与原有 Git 历史。源码来源及
保存点见 [SOURCE-REVISIONS.md](SOURCE-REVISIONS.md)。

## 记忆方式

每个角色有独立的 Markdown 笔记目录和 SQLite 来源库。上下文固定载入
角色卡与双方身份；模型在需要时主动调用笔记工具搜索、阅读或编辑记忆。
当前笔记产品不使用 embedding 或向量检索。

DSH 压缩开始信号和手动操作可以触发独立的后台记忆整理；每日整理在
宿主运行期间按计划执行。QQ 插件沿用原生 DSH 会话、模型配置与角色绑定。

## 开发与安装

当前兼容验证目标为 Node.js 24、DSH `0.2.1-rc.2`。进入各插件目录分别
安装依赖、检查和构建，不需要在仓库根目录安装一套共享依赖：

```powershell
cd pupu-notes
npm install
npm run check
npm run build
```

QQ 插件在自己的目录使用 `npm ci`、`npm run typecheck`、`npm test` 和
`npm run build`。打包、安装与环境要求分别见：

- [笔记安装说明](pupu-notes/docs/INSTALL.md)
- [笔记测试范围与限制](pupu-notes/docs/TEST-REPORT.md)
- [QQ 插件说明](dsh-qq-notes/README.md)
- [QQ 验证记录](dsh-qq-notes/docs/TEST-REPORT.md)

`operations/` 中的脚本记录本机迁移流程，含绝对路径和写入正式数据的
操作，不是通用安装程序。不要为了保存或安装源码重新执行迁移、清理。
QQ 界面的工作区默认路径、`scripts/verify-legacy.mts` 的旧库验证路径
同样需要按实际机器确认。

## 数据与授权

仓库只保存源码、合成测试及说明，不包含真实角色记忆、私聊正文、账号
凭据、运行日志、备份数据库或导入包。运行时的数据和模型凭据由本机 DSH
管理，部署到另一台机器需要自行配置并显式导入所需数据。

各组件的授权条款独立：`pupu-notes/` 使用其目录内的 MIT License，
`dsh-qq-notes/` 当前 package.json 标记为 `UNLICENSED`，第三方声明见其
`THIRD_PARTY_NOTICES.md`。仓库根目录不授予额外授权。
