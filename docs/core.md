# OptChat core

`pi-optchat/core` is OptChat's memory without Pi: the log, the summary tree and its views, zoom/date/search, the compactor, cache marks and memory's prompts. It is meant for hosts such as Pi Durable in a Cloudflare Durable Object. The Pi extension (`pi-optchat`) is built on it and behaves exactly as before.

Core imports nothing from Pi or Node at runtime: only `typebox` (the tools' schemas) and pi-ai's types. `test/core-boundary.test.ts` keeps it that way. The four Pi packages are optional peer dependencies, so installing `pi-optchat` outside Pi pulls in none of them.

It ships as TypeScript, like the extension, so the host needs a bundler (Wrangler, esbuild, tsx). A host that type-checks with `tsc` needs `allowImportingTsExtensions`.

## What a host supplies

- **A `Store`:** six operations (`load`, `append`, `appendNode`, `saveView`, `putImage`, `image`), sync or async. Memory loads once, then works in RAM and issues its writes in order. Pi's is `FileStore` (`src/store.ts`).
- **The compactor's model:** `createCompressor({ model, retryable })`, where `model()` returns `{ model, reasoning, stream }` for each call (pi-ai's `Models.streamSimple` or one with its shape) and `retryable` is pi-ai's `isRetryableAssistantError`.
- **Image names**, if it keeps images: `logMessage` and `textContent` take an `imageRef` that names an image `[image <16 hex digits>]`; `loadImages` reads those back from the store.

## What it exposes

`src/core/index.ts` lists the exports by name: only these are public.

```ts
import { createCompressor, logMessage, memoryTools, openMemory, withView } from 'pi-optchat/core';

const memory = await openMemory(store, createCompressor({ model: () => ({ model, stream: models.streamSimple.bind(models) }), retryable }));
logMessage(memory, message);                       // each message of a turn, as the recipe's kinds
await memory.settle();                             // until the view's lines are built
const request = withView(run, memory.render());    // the view goes before the user's words
const [zoom, date] = memoryTools(() => memory);    // VIEW_DOC tells the model how to use them
```

- `openMemory(store, compress, { warn, budget, jobs, retryMs })`, and `Memory`: `append`, `render`, `settle(signal?, 'turn' | 'tree' | 'ahead')`, `zoom`, `search`, `date`, `onChange`, `close`, plus `root`, `tree`, `view`, `pending`, `lastError`.
- `Store`, `Saved`, `Lease`, `Mime`, `isMime`, and the record types `Entry`, `Summary`, `Origin`, `Kind`. An entry with an `origin` is imported history, which the summarizer treats as historical; `origin.source` is any label the host picks ("email").
- `createCompressor({ model, retryable, onUsage?, accepted?, retryDelays?, system? })` (`system`: the compactor's prompt, `COMPACT` by default), `ACCEPTED_BYTES`.
- `logMessage(memory, message, { kind?, receipt?, imageRef? })` (every entry it appends gets `receipt`, so a host can use it as a cursor), `textContent`, `withView`, `boundedMessage`, `completedExchange`, and the mid-turn refresh helpers (`refreshBudget`, `refreshPoint`, `refreshedRun`).
- `memoryTools(memory, runs?)` (zoom and date; `runs` adds zooming into a subagent's chat), `searchTool`, `loadImages`, `isImage`.
- `cachePayload` (Anthropic: the view's cache marks, as a request's `onPayload`).
- Prompts: `COMPACT`, `VIEW_DOC`, `CONTINUITY`, `SEARCH_DOC`, `allowSearch`, `TURN_REFRESHED`.

Not in core yet: the turn itself (when to snapshot the view, refresh mid-turn, replay the previous exchange), which Pi does in `src/index.ts`; staged imports; and loading log text lazily, which a host with a large log in a 128 MB isolate will need.
