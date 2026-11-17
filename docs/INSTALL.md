# 安装、升级和回滚

以下步骤针对本机 DSH 0.2.1-rc.2 Web profile。安装者需要 Node.js 24 和可运行的 DSH；不需要旧 PuPu 目录、旧虚拟环境或 Python。

## 本地安装

先在产品目录构建本地包：

```powershell
npm install
npm run pack:local
```

将生成的 `artifacts/dsh-pupu-notes-0.1.0.tgz` 安装到测试 profile（把 `web` 换成你实际使用的 profile）：

```powershell
dsh plugin --profile web add "D:\ProjectICreate\PuPuBot\pupu-notes\artifacts\dsh-pupu-notes-0.1.0.tgz"
```

`cordis.patch.yml` 启用 bundle。没有 HMR 的 profile 需要重启 DSH，才能加载新的 Host 和原生 UI；安装前已经运行的旧会话继续使用旧插件。安装后在 DSH 侧栏的“插件”页确认“蒲蒲笔记”已启用，再打开“设置 → 蒲蒲笔记”。

插件使用独立数据根，不会读写旧 `pupu-dsh`。首次创建角色会生成独立角色目录。你可以在页面中创建新角色，也可以预检旧 SQLite / `.pupumem` 后复制导入。人物映射必须由安装者确认，重复导入不会自动合并同名人物。

## 独立 MCP

将某个角色目录作为兼容 MCP 宿主的私有记忆库：

```powershell
node .\dist\mcp.mjs --root "C:\Users\<你>\.dsh\data\pupu-notes\roles\<角色ID>" --name "璐璐"
```

MCP 使用 stdio，模型可见工具名为 `notes`。它和 DSH 插件共用 Markdown 和来源库，但不会自动替宿主注入完整记忆。同一角色目录同时只允许一个记忆引擎；将同一库交给独立宿主前，先停止占用它的 DSH 插件，或使用导出的独立副本。

发行目录另有 `pupu-notes-mcp-0.1.0.zip`，供独立宿主使用。解压后将 Node.js 24 和 `mcp.mjs --root <角色目录>` 配置为 stdio MCP 启动命令。DSH 安装使用 `.tgz`。

## 更新

安装新 `.tgz` 前导出当前角色的完整迁移包。DSH 无 HMR 时安装完成后重启 profile；新版本只会在独立 `pupu-notes` 数据根中升级。若升级失败，保留原 `.tgz` 和数据目录，不要删除角色目录。

## 回滚

停止 DSH 后，在 profile 中移除当前包并重新安装上一版：

```powershell
dsh plugin --profile web remove dsh-pupu-notes
dsh plugin --profile web add "D:\backups\dsh-pupu-notes-previous.tgz"
```

回滚只改变插件代码和配置，不删除 `pupu-notes` 数据。旧 PuPu 插件和数据仍可单独运行。确认数据包和 UI 都正常后，再由安装者决定是否停用旧插件。

## 卸载

卸载插件不会删除用户数据。先在页面导出完整包，再运行：

```powershell
dsh plugin --profile web remove dsh-pupu-notes
```

若需要彻底清除数据，请在 DSH 停止后手动删除 `pupu-notes` 根目录；该操作不可由插件自动执行。
