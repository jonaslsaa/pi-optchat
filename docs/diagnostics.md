# Local diagnostics

OptChat can write best-effort **local OTLP-compatible JSONL logs**. Logging is off by default. It does not send telemetry anywhere, run an APM exporter, add a diagnostics command/UI, or change model retries/timeouts.

From this checkout, load the extension explicitly with a fresh OptChat data directory:

```sh
OPTCHAT_HOME="$(mktemp -d)" OPTCHAT_DIAGNOSTICS=1 pi --no-extensions -e ./src/index.ts
```

Create a test profile in the profile picker. This isolates OptChat data and disables extension discovery for this run; Pi still uses its normal agent configuration and provider authentication. It does not install a package or change persistent extension configuration. `OPTCHAT_DIAGNOSTICS` is independent of Pi's `PI_TELEMETRY` install/update attribution setting.

Logs live in `$OPTCHAT_HOME/diagnostics/` (default `~/.optchat/diagnostics/`), **outside** `profiles/`. Never put them inside a profile: profile checkpoints stage their own directory. The logger rejects destinations containing a `profiles` path component, symlink destinations and, on POSIX, non-private diagnostic directories.

## Records and correlation

Each line is an OTLP JSON `ExportLogsServiceRequest` envelope: `resourceLogs` → `scopeLogs` → `logRecords`. Resource metadata describes Pi/Node; instrumentation scope identifies OptChat and pins the diagnostic schema/GenAI convention revision. Timestamps/int64 values use decimal strings, trace/span IDs use hex, attributes use typed `AnyValue`s. This writes only the **log signal**, not trace or metric exports.

MVP instrumentation covers:

- runtime start/graceful shutdown and profile open;
- summary build attempts, cache-gate waits, compactor model attempts, retries and refusal fallbacks;
- memory waits, including ready versus stalled;
- memory log, summary-node and view storage completion/failure;
- handoff summary model attempts.

Background builds are independent traces. Build/cache/model/store records correlate through a process-local opaque memory identity, memory block index/size and build-attempt number. Nested calls share trace context. The inner model-attempt counter is separate from the scheduler's build-attempt counter. Profile/session identity is captured when a memory opens; optional agent identity is inherited when supplied. Main-turn IDs are attached to memory waits, including waits during mid-turn memory refresh. A background build is **not** presented as a child of a later turn waiting for it, and there is no full main/subagent turn/tool instrumentation in this MVP.

Durations use a monotonic clock and seconds. `optchat.model.time_to_first_event` measures the first non-start normalized SDK event, not necessarily the first provider token/chunk. A local AbortSignal deadline is an error (`error.type=timeout`, `optchat.error.source=deadline`); a provider timeout has source `provider`. Generic aborts use outcome `cancelled` with a safe reason enum. We do not infer user intent from an arbitrary abort message.

Usage is included only when validated and nonzero. Input tokens include cache-read/write; reasoning is a subset of output, not added again. All-zero initialized SDK usage is `unknown`, not proof of a free request. Missing response/model/request IDs and status codes are not invented.

## Privacy

A closed metadata whitelist excludes prompts, responses, summaries, memory contents, tool arguments/results, raw errors/stacks, authorization/cookies, cache prefixes, paths, host/user names and arbitrary headers. Bodies/event names are fixed vocabulary. Only three explicitly allowed request-ID headers may be kept; values are length/character/secret-pattern checked. Unknown attributes and accessors are dropped; custom getters are never executed while copying diagnostic attributes.

This is metadata, **not guaranteed anonymous data**. Request IDs, model/provider names, opaque session/agent IDs, process IDs and timing can still identify activity. A credential deliberately placed in a syntactically valid permitted metadata field cannot be universally detected. Treat logs as private and inspect before sharing. Profile aliases are HMAC-derived using a fresh per-writer secret; paths and profile names are not stored.

## Bounds and failure behavior

Defaults: 8 KiB/record, 32 attributes, 1000 queued records or 1 MiB, 200 ms flush interval, 5 MiB/segment, 3 segments/instance, 7-day cleanup of dead-writer files, and a **soft** 50 MiB directory budget. Invalid numeric overrides fall back to defaults; positive overrides are capped. Records fitting individually are split across batches, not discarded merely because a combined batch exceeds a segment limit.

Each writer owns its files; another live writer's files are never removed. Simultaneous processes can briefly exceed the soft global budget. PID reuse can conservatively retain an old writer's files longer. POSIX directories/files are 0700/0600; Windows needs its normal private-user-directory/ACL guarantees in addition to file modes.

Full queues/oversize/budget exhaustion drop records and count them. Successful later writes can report those counts. A disk failure disables only diagnostics, counts the drained batch and remaining queue as lost and warns once, with no recursive error logging. A failed append may have partially written; its batch is conservatively counted as lost rather than retried/duplicated. Diagnostic failure must not change application return values or original thrown errors.

Graceful shutdown waits at most one second for flushing and accounts queued leftovers. An already submitted append may finish later. This is not durable storage: SIGKILL, crashes, partial appends, rotation and disk stalls can lose records. An absent end record means **unknown**, not proof of a timeout or failure. If disk writing is unavailable, the warning/in-memory counters are the only reliable drop indication.

## Validation and limits

Offline tests validate the emitted OTLP JSON subset with an independent JSON Schema checker, including IDs/types/severity, privacy, hostile objects, parallel context isolation, cancellation/deadline semantics, usage, memory retries, rotation, bounds, drop accounting, storage failures and shutdown timeout. This is **not** a protobuf binary roundtrip, Collector ingestion or APM interoperability claim.

The full offline suite runs with diagnostics enabled and disabled against the pinned Pi SDK 1.0.2 dependencies. Synthetic-provider integration tests cover compactor/handoff transport retries, refusal-to-clipped-source fallback, source limits, saved chat/compaction view reopening and mid-turn memory refresh. SDK sessions verify the same model context and memory entries in both modes, with a shared turn ID across refresh waits. Tests use temporary HOME/agent/OptChat directories; no TUI or live-provider validation is claimed.

Windows integration, throughput/CPU/RSS benchmarks and broader lifecycle coverage remain follow-up work. No support bundle, UI, exporter, agent status screen or automatic crash recovery is included.
