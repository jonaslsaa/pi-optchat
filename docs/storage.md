# Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`). The README has the table of what each path holds.

## Git checkpoints

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

## Import generations

An import builds a new memory generation (`memories/<id>/`) and switches `active-memory.json` to it only when the whole tree is ready. Older generations are kept.

## The `Store` seam

Memory reaches disk through one seam, `Store` in `src/store.ts`: the log, summary nodes, saved view and images, which is what would travel between machines.

- Runs, recovery journals, imports and their pointer, usage, settings and `AGENTS.md` stay local files.
- `FileStore` (the layout in the README) is the only store today. Another, such as Postgres, would implement the same few operations.
- Its lease (take, heartbeat, release) is optional: without one, OptChat keeps its machine-local profile lock.
- Import records (`imports/*.json`, the staging generations and the `active-memory.json` pointer) are per machine, so a second machine with the same `~/.claude` or Codex history on disk may offer those sessions for import again.

## Windows differences

- **Named pipes, not socket files.** The profile lock and the connected-window bridge listen on `\\.\pipe\optchat-<hash>-lock` and `optchat-<hash>-windows`, where the hash comes from the profile path: a Windows pipe has no filesystem entry inside the profile, so the hash is the only thing separating profiles. Pipes are machine-wide and carry no file permissions, so a Windows profile is not permission-protected the way a POSIX socket file (mode 0600) is.
- **File modes and fsync** (profile folder 0700, socket 0600, directory fsync after a rename) are POSIX-only and are skipped on Windows.
