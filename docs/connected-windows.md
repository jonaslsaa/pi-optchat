# Connected windows, background agents and headless runs

Each profile is locked to one Pi process. This page covers the ways a second Pi can reach a profile that is already open.

## Connected windows

If you open the same profile in a second terminal, Pi offers to connect it to the original window as a subagent, or to go back to the profile picker. Only an interactive or RPC Pi accepts connections; a headless `pi -p` run holding the profile does not.

- Your first message starts a subagent in the second window's working directory. Later messages continue the same conversation.
- The window looks like a normal Pi chat: replies, tool calls with their output and running time, the working spinner, and reports from the subagent's own agents in the dark box. Ctrl+O expands tool output.
- The subagent runs inside the original process, which stays the only writer of memory. It appears in the original window's inspector and takes one of the profile's active agent slots (Max active agents, 8 by default). While it is open, the original window can't switch profile or import.
- The main agent is told when the conversation starts. Use `/tell-main <message>` to message it yourself; the subagent can use `tell_parent`, and the main agent replies with `tell`. Routine turns don't wake the main agent.
- Text only. For images, give the agent a file path.
- The connection is a local socket restricted to your OS user. No daemon or server. On Windows it is a machine-wide named pipe without file permissions, so it has no such restriction (see [storage.md](storage.md#windows-differences)).

### Ending a conversation

- Run `/complete` when done. The window closes, remaining work stops, and the compactor writes a handoff for the main agent: decisions, changes, evidence, failures, unfinished work, and links to the transcripts.
- Closing or force-quitting the window also produces a handoff, marked **interrupted**.
- If the original window is closed cleanly, handoffs are delivered on next start. If it is killed, reopening the profile recovers unfinished handoffs (work is not restarted).
- Closing the original window, or running `/reload` in it, ends every connected conversation; Pi gives no chance to warn before a reload. The connected window then shows **disconnected**. `/new` there starts over: after the profile picker if Pi was started without `--optchat-profile`, a profile still open elsewhere offers **Start a connected subagent conversation here** again, and a free one opens in this window.

### Handoff limits

The whole transcript is summarized in one call if it fits in about 128,000 input tokens (estimated at 4 bytes per token; less on smaller models), otherwise in chunks. Output is up to 16,000 tokens, with a 5-minute timeout per call. If summarizing fails, a labelled fallback still reports the task, last result, and transcript locations.

## Open an existing background agent in another terminal

When the profile is already open, `pi --optchat-profile work` in a second terminal offers **Start a connected subagent conversation here**, followed by **Open subagent <id> · <state> · <task>** for each running, waiting or paused background agent. You can also skip the menu with the ID shown in the main window's **Agents** page or a subagent report:

```sh
pi --optchat-profile work --optchat-agent 8ab62e89
```

This opens that **same agent's session** as a normal Pi chat: its task, previous replies and tool results, then live output. Messages you type are guidance to that agent; a paused agent continues when you send one. `/tell-main` still contacts the main agent.

- The original Pi window stays the only owner: it runs the agent, and reports still go to the agent's parent. Opening the window starts no new agent or model call.
- **Closing the terminal or `/complete` only detaches.** The agent keeps running. Stop or interrupt it from the main window's **Agents** page, which can open the same agent at the same time, as can other terminals.
- A finished agent opens for reading, without being restarted.
- This needs interactive Pi and a running owner window. An unknown ID, or a conversation owned by another connected window, is refused rather than starting a new one.
- The attached terminal saves no session to resume; run the command again instead. The agent ID is not a Pi session ID.

## Headless and RPC runs

For headless use (`pi -p`, `--mode rpc`, other extensions' runners), pass `--optchat-profile work`.

- Without it, and without a saved profile in a resumed session, a headless run is plain Pi with no OptChat memory.
- If the requested profile can't open (misspelled, deleted, or busy and not joinable, see below), the run reports the error and doesn't answer.

In RPC and SDK hosts that create sessions themselves (Pi Web), send `/optchat profile work` as the first message of a new session. A profile is open in one session at a time, so a second session on it gets "Profile already running".

### Joining a busy profile with `pi -p`

If the profile is open in another Pi, `pi -p` joins it like a connected window: a subagent in that Pi answers, only its final reply goes to stdout, and the main agent gets the handoff. `--optchat-connect` picks when:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Joins only when the profile is busy. |
| `join` | Always joins, and fails if no Pi has the profile open. |
| `off` | Reports the busy profile as an error. |

- A failed join exits non-zero.
- A profile held by another `pi -p` (or JSON-mode) run can't be joined, since that run exits after its own prompt. Once it exits, `auto` opens the profile itself; `join` still fails, as no Pi has it open.
