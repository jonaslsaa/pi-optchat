// One OptChat agent per Durable Object, on Cloudflare's PiHarness: the wiring a host such as Board AI needs, plus the counters
// proof.mjs reads. Pi Durable keeps the run (transcript, inbox, retries, crash recovery); OptChat keeps the memory, in the same
// SQLite database, and builds every request from it.
import { DurableObject } from 'cloudflare:workers';
import { isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createRegistry, defineExtension, GenerationTask, Harness, hook, ResetEntry, ROOT_CONVERSATION_ID, section } from '@earendil-works/pi-durable';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { createCompressor, isMime, openMemory, type ImageStore, type Kind, type Memory } from '../../../src/core/index.ts';
import { optchat, SqliteStore, withCacheMarks } from '../../../src/durable/index.ts';

type PiContext = Parameters<Harness['inspect']>[0];
interface Env { AGENT: DurableObjectNamespace<Agent>; IMAGES: R2Bucket; ANTHROPIC_OAUTH_TOKEN: string; MODEL: string; COMPACTOR: string; BUDGET: string }
type Usage = AssistantMessage['usage'];

/** Memory's images in R2, keeping large binary data out of the object's SQLite (its row size limit and storage cost); each object
 * keeps its own under `prefix`. */
const r2Images = (bucket: R2Bucket, prefix: string): ImageStore => ({
  putImage: async (name, mimeType, data) => { await bucket.put(`${prefix}/${name}`, data, { httpMetadata: { contentType: mimeType } }); },
  image: async name => {
    const object = await bucket.get(`${prefix}/${name}`), mimeType = object?.httpMetadata?.contentType;
    return object && mimeType && isMime(mimeType) ? { mimeType, data: new Uint8Array(await object.arrayBuffer()) } : undefined;
  },
});

export class Agent extends DurableObject<Env> {
  private readonly registry = createRegistry();
  private readonly models = createModels({ authContext: {
    env: async name => name === 'ANTHROPIC_OAUTH_TOKEN' ? this.env.ANTHROPIC_OAUTH_TOKEN : undefined,
    fileExists: async () => false,
  } });
  /** Opened with Pi the first time, and kept when PiHarness reopens Pi. */
  private optchat?: { memory: Memory; extension: ReturnType<typeof optchat>; stop?: () => void; context?: PiContext };
  /** Since this object started: summary calls, and each main-model request's usage. */
  private readonly stats = { started: Date.now(), summaries: [] as Usage[], requests: [] as Usage[], warnings: [] as string[] };

  private readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      if (!this.optchat) {
        this.models.setProvider(anthropicProvider());
        const compactor = this.models.getModel('anthropic', this.env.COMPACTOR)!;
        const compress = createCompressor({
          model: () => ({ model: compactor, stream: this.models.streamSimple.bind(this.models) }),
          retryable: isRetryableAssistantError,
          onUsage: reply => { this.stats.summaries.push(reply.usage); this.saveBoot(); },
        });
        // The adapter shares Pi's queue on this storage, so OptChat's writes never interleave with a Pi transaction.
        const store = new SqliteStore(new DurableObjectSqliteDatabase(this.ctx.storage), (sql, ...params) => this.ctx.storage.sql.exec(sql, ...params),
          { images: r2Images(this.env.IMAGES, this.ctx.id.toString()) });
        const memory = await openMemory(store, compress,
          { budget: Number(this.env.BUDGET), warn: s => {
            this.stats.warnings.push(s);
            // A failed save stops memory's log until the object restarts, which then logs the rest from Pi's transcript: restart now.
            if (this.optchat?.memory.saveError) this.ctx.abort(s);
          } });
        this.optchat = { memory, extension: optchat({ memory }) };
        this.registry.install(this.optchat.extension.extension);
        this.registry.install(defineExtension({
          name: 'board',
          sections: [section('persona', () => 'You are the assistant of a Norwegian housing board. Answer briefly.', { tag: false })],
          hooks: [hook(GenerationTask, { afterResponse: message => { this.stats.requests.push(message.usage); } })],
        }));
      }
      const pi = await Harness.open(storage, {
        models: withCacheMarks(this.models), registry: this.registry, onWake,
        settings: { compaction: { enabled: false } },
        onReport: (error, info) => { this.stats.warnings.push(`${info.type}: ${error instanceof Error ? error.message : String(error)}`); },
      }, context);
      this.optchat.stop?.();
      this.optchat.stop = this.optchat.extension.attach(pi, context);
      this.optchat.context = context;
      return pi;
    },
    defaults: { model: { provider: 'anthropic', id: this.env.MODEL }, thinkingLevel: 'off' },
  });
  private readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async fetch(request: Request) {
    const url = new URL(request.url);
    await this.harness.pi(); // Opens Pi, and with it the memory.
    const { memory } = this.optchat!;
    switch (url.pathname) {
      // Old history, as an import would add it: straight into memory.
      case '/seed': {
        const messages = await request.json<{ kind: Kind; text: string; date: string }[]>();
        for (const { kind, text, date } of messages) memory.append(kind, text, date);
        return Response.json({ entries: memory.root.length });
      }
      case '/prompt': {
        const { text } = await request.json<{ text: string }>();
        const result = await this.harness.prompt(text);
        return Response.json({ status: result.status, reason: result.reason, text: result.text });
      }
      // Waits until OptChat has reset the context and remembered the last run, and the next turn's view is built.
      case '/settle': {
        const pi = await this.harness.pi(), context = this.optchat!.context!;
        const remembering = async () => (await (await pi.conversation(ROOT_CONVERSATION_ID, context))!.context(context)).entries.some(e => e.kind !== ResetEntry.kind)
          || (await pi.inspect(context)).tasks.some(task => task.record.kind === 'optchat.remember');
        while (await remembering()) await new Promise(resolve => setTimeout(resolve, 50));
        await memory.settle();
        return Response.json(this.report());
      }
      case '/stats': return Response.json({ ...this.report(), alarm: await this.ctx.storage.getAlarm() });
      case '/view': return new Response(memory.render());
      case '/log': return Response.json(memory.root.map(({ i, kind, receipt }) => ({ i, kind, text: memory.text(i).slice(0, 120), receipt })));
      case '/tables': return Response.json(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map(row => row.name));
    }
    return new Response('not found', { status: 404 });
  }
  /** Each start of this object, kept in its storage: an object that an alarm woke and that was evicted again before the
   * next request still shows up, with the summaries it made. */
  private saveBoot() {
    const boots = this.ctx.storage.kv.get<{ startedAt: number; summaryCalls: number }[]>('boots') ?? [];
    const boot = boots.find(b => b.startedAt === this.stats.started);
    if (boot) boot.summaryCalls = this.stats.summaries.length;
    else boots.push({ startedAt: this.stats.started, summaryCalls: this.stats.summaries.length });
    this.ctx.storage.kv.put('boots', boots);
  }
  private report() {
    this.saveBoot();
    const { memory } = this.optchat!;
    return {
      uptimeMs: Date.now() - this.stats.started, entries: memory.root.length, nodes: memory.tree.size, pending: memory.pending,
      viewBytes: memory.size, summaryCalls: this.stats.summaries.length, requests: this.stats.requests,
      lastError: memory.lastError, warnings: this.stats.warnings,
      boots: this.ctx.storage.kv.get('boots'),
    };
  }
}

export default {
  fetch(request: Request, env: Env) {
    // For proof.mjs to see the Worker is up without waking an object, which would hide whether an alarm woke it.
    if (new URL(request.url).pathname === '/ready') return new Response('ready');
    return env.AGENT.get(env.AGENT.idFromName(new URL(request.url).searchParams.get('agent') ?? 'demo')).fetch(request);
  },
} satisfies ExportedHandler<Env>;
