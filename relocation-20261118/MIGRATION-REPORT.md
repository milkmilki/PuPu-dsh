# C 盘临时工作迁回 D 盘

日期：2026-11-18。目标由当前会话确认：
`D:\ProjectICreate\PuPuBot\pupu_20260425_105129`，分别使用独立子目录。

## 现在的位置

| 内容 | 当前目录下的位置 |
| --- | --- |
| QQ 适配器独立源码及 Git 历史 | `dsh-qq-notes` |
| 构建环境、依赖及原始构建材料 | `.build\dsh-qq-build-20261118` |
| 仆仆、璐璐的 QQ 工作区 | `workspaces\qq\pupu`、`workspaces\qq\lulu` |
| 网页调试工作区 | `workspaces\web` |
| 启动器 | `operations\start-dsh.ps1` |
| 部署脚本、旧部署恢复备份和运行日志 | `operations\pupu-notes-activation-2026-11-18T01-31-10-926Z` |
| 磁盘事故核对快照 | `operations\disk-audit-dialogue-copy` |
| 本次迁移快照、计划、日志及核对报告 | `operations\relocation-20261118` |

笔记插件源码本来就在 `D:\ProjectICreate\PuPuBot\pupu-notes`，这次保持原位置。
DSH 自身的账号、凭据、正式记忆数据库和会话存储继续由
`C:\Users\57859\.dsh` 管理。该用户数据目录没有整体搬迁或删除。

## 切换与核对

- 独立源码 HEAD 为 `ba42a22fc94d121347f54308faeedce1394ae039`，
  分支为 `codex/pupu-notes-adapter`，独立 Git 历史保留。
- 源码 180 个文件和完整构建目录 28,466 个文件复制后逐一核验 SHA256。
- 依赖 junction 指向 D 盘构建目录。类型检查、31 项 QQ 单元测试、
  发行包检查和 Host 导入通过；本次没有运行真实模型测试。
- 正式 `web` profile 使用官方包管理器重新安装 D 盘的
  `dsh-qq-0.1.6.tgz`。package.json 及两份 lockfile 均指向 D 盘。
- 保留三个 workspace ID 和五个 session ID，仅迁移工作区路径与会话头的 cwd。
  安装的 DSH 为 `0.2.1-rc.2`；离线迁移工具锁定该 SDK 的源码 SHA256。
- 五份会话的压缩事件尾原字节及 22 个事件保持一致。迁移工具通过
  5 项合成回归，独立检查另覆盖 17 个中断与回滚边界。
- DSH 已通过新启动器恢复，网页 3090，QQ 18080/18081/18082。
  两条 QQ 路由自动恢复 active，两账号连接恢复，无新建或重绑会话。
- 网页角色／说话者选择器显示正常。验证过程没有发送网页或 QQ 消息。

## 数据完整性

离线一致快照共 534 个文件、80,551,335 bytes，逐文件 SHA256 核验通过。
独立对照报告记录：

- 501 份 Markdown 的路径和字节完全一致：仆仆 252 份，璐璐 249 份。
- 6,558 条对话、2 个角色、5 个绑定完整保留。
- 15 个记忆任务完整保留：12 个排队、3 个完成。
- QQ contacts 4、inbox 111、outbox 140、input_batches 45、
  input_batch_members 85；全部业务记录与快照逐行一致。
- QQ 没有额外发送、重放或丢失消息。只出现正常的运行进程持有者变化。

原生工作区迁移前的原件保留在计划指定的 `.dsh\backups\relocation-*`
内，另有本目录下的 `offline-backup`。已有新消息后，不应直接回滚旧快照；
应按 `README.md` 说明核对并单独处理。

## 清理凭证与使用

最终 C 盘副本清理以 `cleanup-result.json` 为准，清理前文件对照记录在
`cleanup-precheck.json`。它们只针对本次搬迁的四处临时工作副本及已空的
QQ 工作区父目录，不删除正式 DSH 数据。

清理已完成。上述 C 盘临时路径以及旧网页工作区路径均已不存在。
删除后在 D 盘再次通过类型检查，Git 工作区保持干净；在线检查再次确认
两条 QQ 路由 active、两账号 connected、501 份记忆内容不变，待发消息为 0。
完成时 D 盘剩余约 70.44 GiB。见 `post-cleanup-filesystem.json` 和
`post-cleanup-live.json`。

正常启动：

```powershell
& 'D:\ProjectICreate\PuPuBot\pupu_20260425_105129\operations\start-dsh.ps1'
```

服务已运行时启动器会拒绝重复占用 3090 端口。恢复备份含私人记忆，不应
加入公开发行包或推送至公共仓库。当前旧仓库仅通过本地
`.git\info\exclude` 排除了这些新增独立目录。

详细证据：

- `independent-post-relocation-data-audit.json`
- `post-switch-live.json`
- `post-cleanup-live.json`
- `post-cleanup-filesystem.json`
- `cleanup-result.json`
- `workspace-relocation.plan.json` 及同名操作 journal
- `.build\relocation-reports\dsh-qq-20261118\verification.json`
- `dsh-after-migration.jpg`
