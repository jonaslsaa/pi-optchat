# Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`). The README has the table of what each path holds.

## Git checkpoints

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

## Import generations

An import builds a new memory generation (`memories/<id>/`) and switches `active-memory.json` to it only when the whole tree is ready. Older generations are kept.

## Guidance history

`guidance/contents/<sha256>.txt` holds each distinct observed source or supplied text once. Human-readable paths under `guidance/sources/<encoded-source>-<path-hash>/<version>/<original-basename>` hard-link to those contents. Beside each original, `metadata.json` records its original path, content version, first capture time and source modification time at that capture. If injection removes a UTF-8 BOM, `supplied.txt` identifies the exact transformed text separately. Source scope and ordering belong to immutable `guidance/revisions/<id>.json` manifests. Archive paths in these manifests are relative, so moving the whole profile preserves retrieval.

`guidance/requests/<uuid>.json` binds an individual agent/session request to its ordered revision. Main-memory entries carry only a request reference as metadata; import append and rebuild preserve it when entries are renumbered. Subagent transcripts keep custom request boundaries, allowing retained messages to be matched before or after Pi compaction. Associations use request identities, not timestamp proximity between parallel agents.

A request record is evidence of the guidance prepared for injection, not proof that a provider accepted the request or the agent obeyed it. Inputs interrupted before preparation can have a reserved reference without a request record; recall explicitly describes that gap. Work predating the feature is left unannotated. Corrupt or missing archived contents produce an error rather than a reference presented as valid history.

Guidance checks do not add conversation messages. Transition state is kept in custom Pi transcript entries, and notices are projected at their original work boundary, or labeled as an earlier transition when that boundary has left the visible context. Recall references are tool-result metadata projected into the model request; canonical tool text and both OptChat and Pi summaries omit them. Actual conversation about instructions, or an explicit tool read of an archive, remains ordinary conversation.

Original source edits, moves and deletion never remove archived versions. There is no automatic archive retention limit or pruning; copy the whole profile for backup. A failed read, invalid UTF-8, source larger than 1 MB, combined guidance larger than 1 MB, or failed archive/request write aborts the next request. A missing source removes its scope; a dangling symlink is an error. This history covers injected guidance, not every filesystem edit or the rest of an execution environment.

## The `Store` seam

Memory reaches disk through one seam, `Store` in `src/store.ts`: the log, summary nodes, saved view and images, which is what would travel between machines.

- Runs, recovery journals, imports and their pointer, usage, settings, `AGENTS.md` and the guidance archive stay local files. A future remote store must also transfer the archive to make its request references readable on another machine.
- `FileStore` (the layout in the README) is the only store today. Another, such as Postgres, would implement the same few operations.
- Its lease (take, heartbeat, release) is optional: without one, OptChat keeps its machine-local profile lock.
- Import records (`imports/*.json`, the staging generations and the `active-memory.json` pointer) are per machine, so a second machine with the same `~/.claude` or Codex history on disk may offer those sessions for import again.

## Windows differences

- **Named pipes, not socket files.** The profile lock and the connected-window bridge listen on `\\.\pipe\optchat-<hash>-lock` and `optchat-<hash>-windows`, where the hash comes from the profile path: a Windows pipe has no filesystem entry inside the profile, so the hash is the only thing separating profiles. Pipes are machine-wide and carry no file permissions, so a Windows profile is not permission-protected the way a POSIX socket file (mode 0600) is.
- **File modes and fsync** (profile folder 0700, socket 0600, directory fsync after a rename) are POSIX-only and are skipped on Windows.
