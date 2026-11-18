# 源码来源与保存点

整理日期：2026-11-18（Asia/Shanghai）。

本仓库通过 Git subtree 导入三个已有独立仓库，保留其原提交为导入提交的
祖先。每个子目录的初始内容与下列来源提交的 Git tree 完全一致。
它们不是需要额外拉取的 Git submodule。

| 子目录 | 原始提交 | 原分支 |
| --- | --- | --- |
| `pupu-notes/` | `e28e43dd678dc816d394e63cbb1b6531e9606179` | `codex/initial-product` |
| `dsh-qq-notes/` | `ba42a22fc94d121347f54308faeedce1394ae039` | `codex/pupu-notes-adapter` |
| `operations/` | `035c8cf6e822ad23031887382e04b745fbf2a5d8` | `codex/local-save` |

原本三个仓库的本地保存标签均为 `save-20261118-d-drive`。组合仓库使用
独立的 `source-backup-20261118` 标签标记首次完整导入。

导入仅包含已跟踪的 Git 内容；构建依赖、发行产物、临时测试目录和运行
数据不随子目录导入。操作工具中的执行计划、journal、恢复备份和认证日志
继续由其白名单 `.gitignore` 排除。
