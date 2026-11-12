# Connected windows, background agents and headless runs

Each profile is locked to one Pi process. This page covers the ways a second Pi can reach a profile that is already open.

## Connected windows

If you open the same profile in a second terminal, Pi offers to connect it to the original window as a subagent, or to go back to the profile picker. Only an interactive or RPC Pi accepts connections; a headless `pi -p` run holding the profile does not. An RPC session on a busy profile connects differently, with its agent in its own process: see [RPC hosts](#rpc-hosts-the-optchat-app-and-t3-code).

- Your first message starts a subagent in the second window's working directory. Later messages continue the same conversation.
- The window looks like a normal Pi chat: replies, tool calls with their output and running time, the working spinner, and reports from the subagent's own agents in the dark box. Ctrl+O expands tool output.
- Messages you send while the agent works show under the spinner until it reads them, as in Pi. At the editor, Esc interrupts the agent (it goes on with any queued messages, or waits for your next one) and Alt+Up (Alt+Q on Windows) takes the newest queued message back to edit. Both follow your Pi keybindings.
- The subagent runs inside the original process, which stays the only writer of memory. It appears in the original window's inspector and takes one of the profile's active agent slots (Max active agents, 8 by default). While it is open, the original window can't switch profile or import.
- The main agent is told when the conversation starts. Use `/tell-main <message>` to message it yourself; the subagent can use `tell_parent`, and the main agent replies with `tell`. Routine turns don't wake the main agent.
- Text only. For images, give the agent a file path.
- The connection is a local socket restricted to your OS user. No daemon or server. On Windows it is a machine-wide named pipe without file permissions, so it has no such restriction (see [storage.md](storage.md#windows-differences)).

### Ending a conversation

- Run `/complete` when done. The window closes, remaining work stops, and the window's own agent writes a handoff for the main agent in the background: decisions, changes, evidence, failures, unfinished work, plus links to the transcripts.
- Closing or force-quitting the window also produces a handoff, marked **interrupted**.
- If the original window is closed cleanly or reloaded, it doesn't wait for the handoff: handoffs, including one still being written after `/complete`, are written and delivered on next start. If it is killed, reopening the profile recovers unfinished handoffs (work is not restarted).
- Closing the original window, or running `/reload` in it, ends every connected conversation; Pi gives no chance to warn before a reload. The connected window then shows **disconnected**. `/new` there starts over: once a profile is chosen as for any new session (see the README's Quick start), a profile still open elsewhere offers **Start a connected subagent conversation here** again, and a free one opens in this window.

### Handoff limits

The handoff is one more turn in the window's own conversation: Pi sends it a closing message asking for the handoff (`windowHandoff` in `src/prompts.ts`), with the same model, thinking level, system prompt and tools. Everything before that message is what the window last sent, so the provider reads it from its prompt cache (if the cache is still warm, about 5 minutes on Anthropic). The window may check things with its tools first; its final reply is the handoff. The closing message and the handoff stay in the window's transcript, but the connected window doesn't show them. Subagents that the ending stopped before they reported are named in the closing message, and their transcripts stay available to the main agent. After a restart, the window's session is reopened from its transcript for this. The turn has a 5-minute timeout.

If the window can't write it (an error, a timeout, an empty final reply, a missing model or transcript), OptChat warns and the compactor writes it instead: the whole transcript and subagent transcripts are summarized in one call if they fit in about 128,000 input tokens (estimated at 4 bytes per token; less on smaller models), otherwise in chunks. Output is up to 16,000 tokens, with a 5-minute timeout per call. If that fails too, a labelled fallback still reports the task, last result, and transcript locations.

## Open an existing background agent in another terminal

When the profile is already open, `pi --optchat-profile work` in a second terminal offers **Start a connected subagent conversation here**, followed by **Open subagent <id> · <state> · <task>** for each running, waiting or paused background agent. You can also skip the menu with the ID shown in the main window's **Agents** page or a subagent report:

```sh
pi --optchat-profile work --optchat-agent 8ab62e89
```

This opens that **same agent's session** as a normal Pi chat: its task, previous replies and tool results, then live output. Messages you type are guidance to that agent; a paused agent continues when you send one. `/tell-main` still contacts the main agent.

- The original Pi window stays the only owner: it runs the agent, and reports still go to the agent's parent. Opening the window starts no new agent or model call.
- **Closing the terminal or `/complete` only detaches.** The agent keeps running. Esc interrupts it here as in a connected window; stop it from the main window's **Agents** page, which can open the same agent at the same time, as can other terminals.
- A finished agent opens for reading, without being restarted.
- This needs interactive Pi and a running owner window. An unknown ID, or a conversation owned by another connected window, is refused rather than starting a new one.
- The attached terminal saves no session to resume; run the command again instead. The agent ID is not a Pi session ID.

## Headless and RPC runs

For headless use (`pi -p`, `--mode rpc`, other extensions' runners), pass `--optchat-profile work`.

- Without it, and without a saved profile in a resumed session, a headless run is plain Pi with no OptChat memory.
- If the requested profile can't open (misspelled, deleted, or busy and not joinable, see below), the run reports the error and doesn't answer.

In RPC and SDK hosts that create sessions themselves (Pi Web), send `/optchat profile work` as the first message of a new session. A second RPC session on a profile that is already open becomes a connected window (next section).

### RPC hosts: the OptChat app and T3 Code

Hosts that drive Pi over RPC start one `pi --mode rpc` process per thread or window. The first one to open a profile owns it. Every later one on the same profile becomes a **connected window**, with its agent in its own process:

- Pi's own agent loop answers there, so the host shows everything as usual, and its tools, approvals and MCP stay its own.
- Each request comes with the profile's memory view, read from disk at the start of the run, plus `zoom`, `search` and `date` on it. The view stays where it was while it doesn't change, so the rest of the conversation is read from the prompt cache. The window never writes the profile's memory and never takes its lock; its conversation reaches memory only as the handoff. Pi's own compaction keeps a long window in bounds.
- It can't delegate: `spawn`, `tell` and `models` are off there. `/tell-main <message>` reaches the main agent.
- `/complete` ends it: the window writes its handoff as one more turn of its own (as above), and the owner logs it. A prompt after that starts a new connected conversation in the same session, with a new ID and without the completed one in its context or handoff, also when the host resumes that session later. A window that closes without `/complete` (a new session, the host stopping it, a crash or a hard kill) is handed off by the owner's compactor from the window's Pi transcript, marked **interrupted**. The owner keeps a copy of that transcript in the profile, so `zoom("<id>")` works after the host deletes the thread.
- If no owner is reachable (none is open, or a `pi -p` run holds the profile), the window still works from the memory on disk, and its handoff waits in the profile's `remote-windows/` for the next Pi that opens it. A window checks for an owner every 5 seconds and registers with one that opens or restarts, which then hands it off when it ends, so a window killed later is not lost.
- Opening a window sends the main agent nothing; its first message does, as in a terminal window. A window in its own process can't be deleted from the owner's Agents page while it runs.
- Known gaps: an idle window killed after the owner restarted, before it re-registered (within 5 seconds), is handed off only when an owner next opens the profile. Liveness is checked by process ID, which the OS may reuse. Once the owner exits, no process owns the profile until a Pi opens it again; windows keep working from disk meanwhile.

`--optchat-connect` picks when, as for `pi -p`: `auto` (default) connects only when the profile is busy, `join` requires a running owner, `off` refuses a busy profile.

**What the host sees.** OptChat sends `setStatus` with key `optchat.role` and a JSON value:

| Value | Meaning |
| --- | --- |
| `{"role":"owner","profile":"work"}` | This process owns the profile: the main chat. |
| `{"role":"window","profile":"work","id":"3f2a9c11","connected":true,"completed":false}` | A connected window. `connected`: whether it reaches the owner now. `id` is its agent ID in the owner's Agents page and reports. |
| the same with `"completed":true` | `/complete` has finished and the handoff is with the owner (or queued). The next prompt starts a new window, sent with a new `id`. |
| the same with `"after":1762956000000` | The window continues a session that was completed before (the next prompt after `/complete`, or a resumed session). `after` is when that happened, in milliseconds since the epoch. The agent reads only messages with `timestamp >= after`, so a host that shows only those shows exactly the conversation the agent has. Absent when nothing came before. |

It is sent during `session_start`, before Pi reads the host's first command, so it has arrived by the time the first `get_state` (or any other command) is answered, and again after `new_session` and `switch_session`, and whenever it changes (only then). No `optchat.role` by then means no profile is open (plain Pi). The window's closing request for its handoff is a hidden custom message (`optchat-handoff-request`), so a host shows the handoff reply but not the request as the user's.

**T3 Code.** Put `--optchat-profile work` in the Pi provider's launch arguments. The first thread you use owns the profile and is your main chat; other threads on it are connected windows. T3 releases a thread after 30 idle minutes (SIGTERM, then SIGKILL a second later), which hands that thread's conversation off as interrupted; a released owner takes its subagents down with it. T3 shows only assistant messages and tool calls, so OptChat's notices there are easy to miss.

### Joining a busy profile with `pi -p`

If the profile is open in another Pi, `pi -p` joins it like a connected window: a subagent in that Pi answers, only its final reply goes to stdout, and the main agent gets the handoff. `--optchat-connect` picks when:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Joins only when the profile is busy. |
| `join` | Always joins, and fails if no Pi has the profile open. |
| `off` | Reports the busy profile as an error. |

- A failed join exits non-zero.
- A profile held by another `pi -p` (or JSON-mode) run can't be joined, since that run exits after its own prompt. Once it exits, `auto` opens the profile itself; `join` still fails, as no Pi has it open.
