# DSH QQ Bridge 0.1.6

Independent QQ private-message gateway and DSH plugin. Requires Node.js 24+, DSH 0.2.1-rc.2, PuPu Notes (`dsh-pupu-notes` 0.1.2+) and a OneBot v11 implementation such as NapCat. No Python runtime is added by this project.

This version uses the same role notebooks and `pupu_notes` tools as Web conversations. It calls the Notes Host service directly and does not call the old `pupu` service or write the old memory database. Source recovery and migration details are in [docs/NOTES-MIGRATION.md](docs/NOTES-MIGRATION.md).

Version 0.1.5 fixes browser activation by bundling the pure Typert remote metadata helper and Zod into the UI artifact. The browser requests only DSH's baseline React/Cordis modules.

Version 0.1.6 restores persisted cold conversations before checking their Notes identity. Restart recovery and manual resume preserve the original role, speaker and session without rebinding or submitting a model prompt.

## Install

Run `npm.cmd ci`, `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`, then `npm.cmd pack`. Install the resulting package as a DSH plugin alongside PuPu Notes. Restart DSH after first installation. Open the plugin's **QQ 连接** settings, create/select workspaces, select existing Notes roles, enter QQ IDs and matching NapCat credentials, then enable each connection.

NapCat reverse WebSocket URLs default to `ws://127.0.0.1:18081/onebot/v11/ws` and `ws://127.0.0.1:18082/onebot/v11/ws`. Supply the matching access token and self ID. The MCP endpoint is `http://127.0.0.1:18080/mcp`. All listeners are localhost-only and conflicts are errors.

When using NapCatQQ Desktop, configure the connection in Desktop's saved bot settings, not only the generated `onebot11_*.json` file: Desktop regenerates that file when starting a bot. Desktop also caches its saved configuration; external file changes require a full Desktop exit/relaunch before restarting the affected account. Closing the main window may only hide it in the tray. A runtime WebUI reload does not update Desktop's in-memory configuration. Keep `messagePostFormat` set to `array` and the connection role set to `Universal`.

New senders are pending until locally approved. Approval grants the corresponding DSH conversation's existing powers and access to the role's entire memory library, including prior owner memories. This is not memory isolation. QQ text cannot approve a DSH approval prompt. Approvals remain in DSH.

Only completed final assistant text is automatically forwarded, including replies triggered in the Web conversation. Images require an explicit `qq_send_image` call. A tool may supply a conversation-reachable attachment ID, or a file path read through DSH's existing `read_image` tool and file permissions. The gateway never reads local image paths.

An image display name is not its opaque attachment ID. Unknown IDs are rejected; when the model has only the DSH-provided local image path, it can use `file_path` through the same permission-checked image-reading flow instead.

## Incoming bursts

Private messages from the same account/contact wait until 20 seconds after the latest new message, then enter DSH as one input. Message boundaries use Chinese comma separators (U+FF0C); original text, punctuation and internal line breaks are unchanged. Images keep their position and use DSH's existing attachment validation. Different contacts/accounts never share a batch. Duplicate OneBot events do not reset the waiting period. Direct Web input is unchanged.

Each batch is bounded by 60 seconds, 20 messages, 256 KiB of serialized segments and DSH's image-count limit. An individual oversized message is left for the normal DSH validation instead of silently truncated. A busy conversation retains input until it can be queued without interrupting the current turn. Already-submitted input is not withdrawn or merged retroactively.

Change **消息合并等待（秒）** under **QQ 连接 → 账号与工作区** (0 disables merging, maximum 60). Timing-only saves take effect for unclaimed input without reconnecting QQ. Sealed batches keep their original member IDs and target conversation across retries/restarts. Retrying or discarding one member operates on its whole sealed batch; discarding does not retract input already accepted by DSH. Pre-upgrade timestamp-less input is delivered individually using its original request ID.

## State and recovery

The DSH profile data directory contains `data/dsh-qq/bridge.db` (configuration, routes, inbox, outbox) and private `credentials.json`. Credentials are not returned by the UI API or MCP tools. On Windows their ACL grants only the current user and SYSTEM. Back up this directory together with the DSH profile; never commit it.

Stable account/contact identities survive nickname changes and restart. Missing/archived conversations or invalid bindings pause the route. Resume explicitly after repairing the cause, or start a new chat. Old conversations are retained. Clean plugin activation does not backfill offline history; after a crash, only completed turns beyond the saved routing boundary are recovered. Confirmed sends are not repeated. An interrupted/timeout send is **uncertain**, blocks later sends to that recipient and requires manual checking/retry. Exactly-once delivery across network failures is not guaranteed. Messages NapCat never reported while offline cannot be recovered here.

## Standalone gateway

`node dist/cli.js <absolute-data-directory>` starts only the gateway against an existing local configuration. Do not run it alongside the plugin against the same data directory or listener ports. The private credential file contains the bearer token for trusted MCP/host clients; never put it in model instructions. Host event subscription is authenticated `GET /host/events`; durable pending input is available at authenticated `GET /host/inbox`. The standalone gateway does not create DSH sessions on its own.

## Rollback

Disable the plugin in DSH. It closes listeners/connections and retains routes, DSH conversations, workspace directories and PuPu data. Re-enable to continue; no memory database restore is needed. Existing Web conversations are never automatically bound or imported.

## Acceptance

See `docs/TEST-REPORT.md`. Simulated OneBot/MCP tests do not constitute real QQ acceptance. Group chat, voice, video and QQ history import are out of scope.
