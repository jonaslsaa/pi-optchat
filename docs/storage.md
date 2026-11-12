# Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`). The README has the table of what each path holds.

## Git checkpoints

Each profile folder is a local Git repository, committed after each turn (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

## Import generations

An import builds a new memory generation (`memories/<id>/`) and switches `active-memory.json` to it only when the whole tree is ready. Older generations are kept.

## The `Store` seam

Memory reaches disk through one seam, `Store` in `src/core/store.ts` (Pi's `FileStore` is in `src/store.ts`): the log, summary nodes, saved view and images, which is what would travel between machines. The saved view (`view.json`) holds the chat's view and the compactions' view, each with its batch state; an older one without the compactions' view refolds it from the chat's, once.

- Runs, recovery journals, imports and their pointer, usage, settings and `AGENTS.md` stay local files.
- Pi uses `FileStore` (the layout in the README). `pi-optchat/durable` has `SqliteStore`, for a Durable Object's SQLite ([durable.md](durable.md)). Another, such as Postgres, would implement the same few operations.
- Its lease (take, heartbeat, release) is optional: without one, OptChat keeps its machine-local profile lock.
- Import records (`imports/*.json`, the staging generations and the `active-memory.json` pointer) are per machine, so a second machine with the same `~/.claude` or Codex history on disk may offer those sessions for import again.

## Reading profiles from another app

`pi-optchat/files` lets another app on the same machine, such as a GUI, read profiles while Pi runs them. It writes nothing and loads only Node at runtime. Like `./core`, it ships compiled; its declarations name pi-ai's types, so without pi-ai installed, use `skipLibCheck`.

- `dataHome()`, `listProfiles(home?)`, `profilePath(name, home?)`: the data directory (`OPTCHAT_HOME` or `~/.optchat`), its profiles, and one's directory. `home` defaults to `dataHome()`.
- `memoryDirectory(profileDir)`: the generation `active-memory.json` points at, or the profile itself.
- `readMemory(memoryDir)`: a closed `Memory` with history, view, zoom, search and images as the files are now. It creates no directory, builds no summary and takes no lock. A directory that doesn't exist reads as an empty memory. A line Pi is still writing is skipped; read again for later messages.
- `readImage(memoryDir, name)`: one kept image, `{ mimeType, data }`, without reading the memory.
- `fingerprint(memoryDir)`: a string that changes whenever the memory does, so an app knows when to read it again.
- `profileOwner(profileDir)`: the Pi holding the profile, `{ profile, pid, host, cwd }`, or `undefined`. It asks the lock and never takes it. It rejects only when a holder is there but doesn't answer in 1.5 s, or describes itself another way: either way the profile is busy.

## Windows differences

- **Named pipes, not socket files.** The profile lock and the connected-window bridge listen on `\\.\pipe\optchat-<hash>-lock` and `optchat-<hash>-windows`, where the hash comes from the profile path: a Windows pipe has no filesystem entry inside the profile, so the hash is the only thing separating profiles. Pipes are machine-wide and carry no file permissions, so a Windows profile is not permission-protected the way a POSIX socket file (mode 0600) is.
- **File modes and fsync** (profile folder 0700, socket 0600, directory fsync after a rename) are POSIX-only and are skipped on Windows.
