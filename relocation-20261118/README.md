# Existing workspace relocation — November 18, 2026

This is a controlled, offline metadata migration for the installed DSH
`0.2.1-rc.2`. DSH has no public workspace relocation or session `cwd` setter.
This helper does not create sessions, change identities, invoke models, send
messages, or call the SDK plugin's `apply`.

The three mappings are:

| Existing directory | Destination under this repository |
| --- | --- |
| `C:\Users\57859\Projects\pupu-qq-workspaces\pupu` | `workspaces\qq\pupu` |
| `C:\Users\57859\Projects\pupu-qq-workspaces\lulu` | `workspaces\qq\lulu` |
| `C:\Users\57859\Projects\pupu-notes-chat` | `workspaces\web` |

The first dry-run found **3 existing workspaces, 5 existing sessions and 22
events**. Only the three registry paths and the five session header `cwd`
fields change. Workspace IDs, session IDs, header timestamps, presets, lineage,
all event bytes, role bindings, persona files, QQ configuration, routes and
watermarks remain unchanged. Projection caches carry `cwd` in their identity;
the SDK rejects an old cache after relocation and rebuilds it.

## SDK verification

`sdk-tools.mjs` loads the installed SDK package, requires the reviewed
`0.2.1-rc.2` version and exact helper declaration anchors, and records its source
SHA256 in the plan. It exposes the original header encoder, strict scanner,
path encoder and Zstandard frame tools in this helper process. Imports still
resolve to the original installed dependencies. No SDK files are modified.
The module's plugin `apply` is never called or exported by this helper.

Each artifact is read by the official strict decoder. Its standalone first
header frame is replaced using the official encoder and compressor; the
remaining compressed event bytes are copied unchanged and compared byte for
byte. Both logical event equality and header equality except `cwd` are checked.
Unknown sessions, extra generations, links, duplicate session IDs, torn
artifacts, occupied destinations or changes after planning cause refusal.

## Commands and preconditions

Run from this directory using Node.js 24:

```powershell
node --test .\relocation.test.mjs
node .\relocate-workspaces.mjs dry-run
```

The default plan is `workspace-relocation.plan.json`. Planning does not alter
live data or create live backup/staging directories. Plans and journals are
private operation records and should not enter a public plugin package.

Before applying:

1. Finish in-flight conversations, then stop the real DSH web/desktop process
   normally, so session writes drain and QQ shutdown records a clean boundary.
2. Keep DSH stopped throughout apply or rollback. The helper additionally
   rejects a live QQ writer lock or matching DSH process.
3. Ensure the destination directories are absent and the reviewed SDK has not
   changed. If messages or configuration changed since planning, generate a
   fresh plan at a new filename while offline; do not bypass the source checks.

```powershell
node .\relocate-workspaces.mjs apply .\workspace-relocation.plan.json --offline-confirmed
node .\relocate-workspaces.mjs verify .\workspace-relocation.plan.json
```

Apply first prepares verified copies on the destination volume and new session
artifacts on the DSH-home volume. Original session directories and C-drive
workspace directories move into the plan's `C:\Users\57859\.dsh\backups\...`
directory, outside the live session discovery root. The registry publishes
through one same-volume atomic file replacement. Cross-file changes have a
durable operation journal; there is no claim of a filesystem-wide transaction.
Original data is retained in the backup.

Before restarting, require the helper's successful verification. After
restart, check that the same workspace/session IDs appear at the D paths,
the two QQ routes remain active with the original identities, and no new
prompt or old-message forwarding was caused by relocation.

## Rollback and interrupted operations

Keep DSH stopped and use the same plan:

```powershell
node .\relocate-workspaces.mjs rollback .\workspace-relocation.plan.json --offline-confirmed
```

Rollback reverses journaled moves, including a rename that completed just
before its journal acknowledgement. It restores the exact original registry
bytes and session artifacts. It does not delete content; destination copies
move back into staging. An interrupted apply should be rolled back before
making a fresh plan. Automatic rollback refuses externally changed outputs;
after new real messages have been written, retain the backup and perform a
separate reviewed migration instead of overwriting new history.

The five synthetic tests cover success and complete rollback, source changes,
unexpected sessions/destination collisions, a partial-commit interruption, and
torn compressed input. Tests use their own temporary C-drive home and never
operate on real DSH data.
