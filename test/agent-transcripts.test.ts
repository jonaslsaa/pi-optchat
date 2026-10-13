import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Children } from '../src/agents.ts';
import { Memory, PAGE } from '../src/memory.ts';
import { memoryTools, result } from '../src/tools.ts';
import { runTranscript } from '../src/transcript.ts';
import { reportParts } from '../src/report-message.ts';
import { removeDir } from './support.ts';

const at = { timestamp: 0 };
const assistant = (content: Extract<AgentMessage, { role: 'assistant' }>['content']): AgentMessage => ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'p', model: 'm',
  stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...at });
const chat: AgentMessage[] = [
  { role: 'user', content: '<chat>\n0+1|a long memory view\n</chat>\n\nYour task:\nRun the tests.', ...at },
  assistant([{ type: 'text', text: 'Running them.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'npm test' } }]),
  { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok '.repeat(2_000) + 'fail 1' }], isError: false, ...at },
  { role: 'user', content: 'Parent says: fix it.', ...at },
  { role: 'user', content: '<chat>\npasted by the parent', ...at },
];

test('a run transcript is its chat as kind|text lines, without the memory view, tool results cut to head and tail', () => {
  const text = runTranscript(chat);
  assert.ok(text.startsWith('user|Your task:\nRun the tests.\ntalk|Running them.\ntool|bash {"command":"npm test"}\necho|bash: ok ok'));
  assert.ok(!text.includes('a long memory view'));
  assert.match(text, /characters omitted; head and tail retained[\s\S]*fail 1\nuser\|Parent says: fix it\.\nuser\|<chat>\npasted by the parent$/, 'only the task prompt loses its memory view');
  assert.ok(text.length < 1_500);
});

test('zoom takes a run id: the transcript in pages that say where to go on; an unknown run says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-runs-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const long = [...chat, ...Array.from({ length: 300 }, (_, i) => assistant([{ type: 'text', text: `step ${i} `.repeat(30) }]))];
  const runs = (id: string) => id === 'abcd1234' ? chat : id === 'feed0000' ? long : id === '12345678' ? [] : undefined;
  const zoom = memoryTools(() => memory, runs)[0];
  const text = async (args: Parameters<typeof zoom.execute>[1]) => (await zoom.execute('call', args)).content.flatMap(c => c.type === 'text' ? [c.text] : []).join('');
  try {
    memory.append('user', 'hello');
    const whole = runTranscript(chat);
    assert.equal(await text({ id: 'abcd1234' }), `${whole}\n[characters 0-${whole.length} of ${whole.length}]`);
    const all = runTranscript(long), first = await text({ id: 'feed0000' });
    assert.equal(first, `${all.slice(0, PAGE)}\n[characters 0-${PAGE} of ${all.length}; go on with offset ${PAGE}]`);
    assert.equal(await text({ id: 'feed0000', offset: PAGE, limit: 10 }), `${all.slice(PAGE, PAGE + 10)}\n[characters ${PAGE}-${PAGE + 10} of ${all.length}; go on with offset ${PAGE + 10}]`);
    assert.equal(await text({ id: '12345678' }), '\n[characters 0-0 of 0]', 'an all-digit run id is a run, even before it has said anything');
    await assert.rejects(zoom.execute('call', { id: 'gone0000' }), /^Error: No run gone0000\.$/);
    await assert.rejects(zoom.execute('call', { id: '87654321' }), /^Error: No run 87654321\.$/, 'eight digits is a run id, even one that is gone');
    assert.equal(await text({ id: '0', n: 1 }), '0+1|user: hello', 'a message id sent as a string still opens the message');
    assert.equal(await text({ id: 0 }), '0+1|user: hello', 'n defaults to 1');
  } finally { await memory.close(); removeDir(dir); }
});

test('the report box leaves out the Full chat trailer', () => {
  assert.equal(reportParts('[abcd1234] Done.\n\nFull chat: zoom("abcd1234")').body, 'Done.');
  assert.equal(reportParts('[abcd1234] A.\n\nFull chat: zoom("abcd1234")\n\n[feed0000] B.\n\nFull chat: zoom("feed0000")', 2).body, '[abcd1234] A.\n\n[feed0000] B.');
});

test('live zoom retains compacted evidence, its page offsets and the unsaved tail through completion and reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-retained-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  let releaseFirst = () => {}, releaseLast = () => {}, calls = 0, compactions = 0, ended = 0;
  let firstStarted = () => {}, lastStarted = () => {};
  const first = new Promise<void>(r => { firstStarted = r; }), last = new Promise<void>(r => { lastStarted = r; });
  const boundaryErrors: unknown[] = [], warnings: string[] = [];
  runtime.registerProvider('retained-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      const step = ++calls, stream = createAssistantMessageEventStream();
      const text = step === 1 ? `EARLY_REPLY ${'x'.repeat(PAGE + 100)}` : step === 2 ? 'SECOND_REPLY' : 'FINAL_STREAMING';
      const message: AssistantMessage = { ...assistant([{ type: 'text', text }]) as AssistantMessage,
        api: model.api, provider: model.provider, model: model.id, stopReason: step < 3 ? 'toolUse' : 'stop' };
      // Force one real SDK compaction after the second tool result, without a model call for its canned summary.
      message.usage.input = step === 2 ? 70000 : 100;
      message.usage.totalTokens = message.usage.input;
      void (async () => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
        if (step !== 2) await new Promise<void>(resolve => {
          if (step === 1) { releaseFirst = resolve; firstStarted(); } else { releaseLast = resolve; lastStarted(); }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (options?.signal?.aborted) resolve();
        });
        const final: AssistantMessage = { ...message, content: step < 3 ? [...message.content,
          { type: 'toolCall', id: `read-${step}`, name: 'read_evidence', arguments: { step } }] : [{ type: 'text', text: 'FINAL_SAVED' }] };
        stream.push({ type: 'done', reason: final.stopReason as 'stop' | 'toolUse', message: final }); stream.end();
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime), choice = () => ({ provider: 'retained-test', model: 'child', thinking: 'off' as const });
  let children = new Children(memory, registry, choice, () => '', async () => {}, text => warnings.push(text), dir, {
    createSession: async options => {
      const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 38000, keepRecentTokens: 1000 }, retry: { enabled: false }, cacheWarming: 'off' });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
        extensionFactories: [pi => { pi.on('session_before_compact', async event => {
          compactions++;
          return { compaction: { summary: 'Earlier steps summarized.', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
        }); }] });
      await loader.reload();
      return createAgentSession({ ...options, settingsManager: settings, modelRuntime: runtime, resourceLoader: loader, tools: ['read_evidence'],
        customTools: [{ name: 'read_evidence', label: 'Evidence', description: 'Return a test record.', parameters: Type.Object({ step: Type.Number() }),
          execute: async (_id, { step }) => result(`EVIDENCE_${step} ${'y'.repeat(6000)}`) }] });
    },
  });
  const deadline = setTimeout(() => { releaseFirst(); releaseLast(); void children.close(); }, 10000);
  const until = async (condition: () => boolean) => {
    const timeout = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < timeout, 'Timed out waiting for SDK events'); await new Promise(r => setTimeout(r, 5)); }
  };
  try {
    const [id] = await children.spawn([{ task: 'Read two records and report.' }], dir);
    const live = children.live(id)!;
    live.session.subscribe(event => {
      if (event.type !== 'message_end') return;
      try {
        assert.ok(!live.session.sessionManager.getEntries().some(e => e.type === 'message' && e.message === event.message));
        assert.equal(children.transcript(id)?.filter(m => m === event.message).length, 1, 'the finalized message is readable before SDK persistence');
        if (event.message.role === 'assistant' || event.message.role === 'toolResult') ended++;
      } catch (error) { boundaryErrors.push(error); }
    });
    await first;
    await until(() => !!live.streaming);
    const zoom = memoryTools(() => memory, run => children.transcript(run))[0];
    const page = async (offset = 0) => (await zoom.execute('test', { id, offset })).content.flatMap(c => c.type === 'text' ? [c.text] : []).join('');
    const before = await page();
    assert.ok(before.includes(`go on with offset ${PAGE}`));
    assert.match(before, /EARLY_REPLY/);
    releaseFirst(); await last;
    await until(() => runTranscript(children.messages(id)).includes('FINAL_STREAMING'));
    assert.equal(compactions, 1);
    assert.ok(!runTranscript(children.messages(id)).includes('EARLY_REPLY'), 'the inspector still shows the compacted working context');
    const retained = runTranscript(children.transcript(id)!);
    assert.match(retained, /EARLY_REPLY/); assert.match(retained, /EVIDENCE_1/);
    assert.equal(retained.split('FINAL_STREAMING').length - 1, 1);
    assert.equal((await page()).slice(0, PAGE), before.slice(0, PAGE), 'compaction preserves the existing page prefix');
    assert.match(await page(PAGE), /EVIDENCE_1/, 'a pre-compaction continuation still reaches the old evidence');
    assert.equal(children.transcript(id, id), undefined, 'a reader still sees only descendants');
    assert.equal(children.transcript('missing'), undefined);
    releaseLast(); await live.completion;
    assert.equal(children.history.records.get(id)?.state, 'completed');
    assert.equal(ended, 5, 'two tool-call messages, two results and the final reply crossed the persistence boundary');
    assert.deepEqual(boundaryErrors, []);
    const finished = runTranscript(children.transcript(id)!);
    assert.equal(finished, retained.replace('FINAL_STREAMING', 'FINAL_SAVED'), 'the stream becomes one saved reply, with no duplicate messages');
    await children.close();
    children = new Children(memory, registry, choice, () => '', async () => {}, text => warnings.push(text), dir);
    assert.equal(runTranscript(children.transcript(id)!), finished);
    assert.deepEqual(warnings, []);
  } finally { clearTimeout(deadline); releaseFirst(); releaseLast(); await children.close(); await memory.close(); removeDir(dir); }
});
