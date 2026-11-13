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

`pi-optchat/files` lets another app on the same machine, such as a GUI, read profiles while Pi runs them, and change them. Only the holder of a profile's lock writes it, except AGENTS.md (Pi reads it fresh each turn): `updateConfig` takes the lock itself or goes through the Pi that holds it. It loads only Node at runtime. Like `./core`, it ships compiled; its declarations name pi-ai's types, so without pi-ai installed, use `skipLibCheck`.

- `dataHome()`, `listProfiles(home?)`, `profilePath(name, home?)`: the data directory (`OPTCHAT_HOME` or `~/.optchat`), its profiles, and one's directory. `home` defaults to `dataHome()`.
- `createProfile(name, home?)`: a new profile with the default config and AGENTS.md, as `/optchat profile` creates one. It throws if the profile exists or the name isn't valid.
- `loadConfig(profileDir)`: the profile's `ProfileConfig`: every setting in `SETTINGS` (label, description, range, default and when a change applies), the `compactor` and `subagent` models, and `main`, the main model last picked in Pi. `defaults` is a new profile's config. It throws on a file it can't read, such as one a newer OptChat wrote with a value this copy refuses.
- `updateConfig(profileDir, patch)`: changes settings and the `compactor` or `subagent` model (`{ provider, model, thinking }`), as `/optchat settings` does, and returns the config as it now is. While a Pi owns the profile, that Pi checks and applies the change at once; a model must be one it is logged in to (Pi's RPC `get_available_models` lists them). With no owner it writes config.json under the profile's lock, keeping keys it doesn't know, and can check a model's shape only. It throws the reason a change can't be made: a bad value, an unknown key, `main` (set it in Pi, for example RPC `set_model`, and Pi saves it), an import in progress, or an owner that takes no changes (`pi -p`).
- `readInstructions(profileDir)`, `saveInstructions(profileDir, text)`: the profile's AGENTS.md. A save applies from the next turn and to new subagents.
- `memoryDirectory(profileDir)`: the generation `active-memory.json` points at, or the profile itself.
- `readMemory(memoryDir)`: a closed `Memory` with history, view, zoom, search and images as the files are now. It creates no directory, builds no summary and takes no lock. A directory that doesn't exist reads as an empty memory. A line Pi is still writing is skipped; read again for later messages.
- `readRuns(profileDir)`: the profile's subagents and connected windows as Pi saved them (`RunInfo[]`: task, state, timestamps, parent, transcript path and so on). A record that can't be read is left out, and a profile without runs gives `[]`. Transcripts are Pi session files: `sessionFile` when the profile has one, and for a connected window running in its own Pi, `window.session` until the owner copies it to `sessionFile` when the window ends. Both are optional. A window with `window.after` shares that session with earlier conversations; its own messages are those with `timestamp >= after`.
- `readImage(memoryDir, name)`: one kept image, `{ mimeType, data }`, without reading the memory.
- `fingerprint(memoryDir)`: a string that changes whenever the memory does, so an app knows when to read it again.
- `profileOwner(profileDir)`: the Pi holding the profile, `{ profile, pid, host, cwd }`, or `undefined`. It asks the lock and never takes it. It rejects only when a holder is there but doesn't answer in 1.5 s, or describes itself another way: either way the profile is busy.

It can also reach a profile's subagents through the Pi that owns it, over that Pi's connected-window socket, as the user would from the Agents page:

- `attachAgent(profileDir, id, onEvent, onDisconnect?)`: opens any subagent by its exact ID (a finished one too, from `readRuns`), or throws. Its conversation so far, then live, arrives as `WindowEvent`s; a `status` event carries `LiveState` (state, model, the streaming reply, running tools, queued messages). The handle has `say(text)` (a message from the user to a live agent), `resume(text)` (the same to a finished one, which goes on in its earlier conversation as the main agent's `tell` would resume it; only the main agent's own subagents resume, and a nested one throws "Only <parent> can resume it"), `interrupt()`, `stop()` (it ends and its parent gets the usual "Stopped by the user" report) and `close()`, which detaches only. A finished agent sends a `finished` event, and another one after a resume.

## Windows differences

- **Named pipes, not socket files.** The profile lock and the connected-window bridge listen on `\\.\pipe\optchat-<hash>-lock` and `optchat-<hash>-windows`, where the hash comes from the profile path: a Windows pipe has no filesystem entry inside the profile, so the hash is the only thing separating profiles. Pipes are machine-wide and carry no file permissions, so a Windows profile is not permission-protected the way a POSIX socket file (mode 0600) is.
- **File modes and fsync** (profile folder 0700, socket 0600, directory fsync after a rename) are POSIX-only and are skipped on Windows.
