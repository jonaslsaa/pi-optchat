import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory, CAP } from '../src/memory.ts';
import { memoryTools } from '../src/tools.ts';
import { runTranscript, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-retention-agent-'));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); }
}

test('named zoom retains evidence through real child compaction, completion, disk reload and resume, with one live tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-retention-'));
  const memory = new Memory(dir, async () => 'summary', () => {}), warnings: string[] = [];
  const argument = 'a'.repeat(20_000) + 'ARGUMENT_MIDDLE_123😀' + 'b'.repeat(20_000);
  const result = 'c'.repeat(30_000) + 'RESULT_MIDDLE_456😀' + 'd'.repeat(30_000);
  let compactions = 0;
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('retention-fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream(), latest = context.messages.at(-1);
      const compression = context.messages.some(m => m.role === 'user' && textContent(m.content).startsWith('<conversation>'));
      if (compression) compactions++;
      const held = !compression && latest?.role === 'toolResult';
      const initial = !compression && latest?.role === 'user' && textContent(latest.content).includes('Your task:\nretain evidence');
      const message: AssistantMessage = { role: 'assistant', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
        stopReason: initial ? 'toolUse' : 'stop', usage: emptyUsage(), content: initial
          ? [{ type: 'toolCall', id: 'evidence-call', name: 'capture', arguments: { value: argument } }]
          : [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }, { type: 'text', text: compression ? 'checkpoint without old evidence' : held ? 'Streaming retained reply' : 'Recent reply' }] };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        if (held) {
          stream.push({ type: 'text_delta', contentIndex: 1, delta: 'Streaming retained reply', partial: message });
          await new Promise<void>(resolve => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        if (options?.signal?.aborted) {
          message.stopReason = 'aborted'; message.errorMessage = 'interrupted';
          stream.push({ type: 'error', reason: 'aborted', error: message });
        } else stream.push({ type: 'done', reason: initial ? 'toolUse' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const options = { settings: () => ({ refreshAt: 0 }), createSession: async (options: Parameters<typeof createAgentSession>[0]) => {
    options?.settingsManager?.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 } });
    return createAgentSession({ ...options, modelRuntime: runtime, customTools: [...options?.customTools ?? [],
      { name: 'capture', label: 'Capture', description: 'Retain fixture evidence.', parameters: Type.Object({ value: Type.String() }),
        execute: async (_id: string, args: { value: string }) => {
          assert.equal(args.value, argument, 'the executable call stays whole');
          return { content: [{ type: 'text' as const, text: result }], details: {} };
        } },
    ] });
  } };
  const registry = new ModelRegistry(runtime), choice = () => ({ provider: 'retention-fixture', model: 'child', thinking: 'off' as const });
  let children = new Children(memory, registry, choice, () => '', async () => {}, warning => warnings.push(warning), dir, options);
  try {
    const [id] = await children.spawn([{ task: 'retain evidence' }], dir);
    const live = children.live(id)!;
    let unpersistedResultSeen = false;
    live.session.subscribe(event => {
      if (event.type !== 'message_end' || event.message.role !== 'toolResult') return;
      const transcript = runTranscript(children.transcript(id)!);
      unpersistedResultSeen = transcript.includes(result);
      assert.equal(transcript.split('RESULT_MIDDLE_456').length - 1, 1);
    });
    await until(() => !!live.streaming);
    const zoom = memoryTools(() => memory, name => children.transcript(name))[0];
    const allPages = async () => {
      let text = '', offset = 0;
      for (;;) {
        const page = await zoom.execute('test', { id, offset });
        const value = textContent(page.content), match = /^([\s\S]*)\n\[characters (\d+)-(\d+) of (\d+)(?:; go on with offset (\d+))?\]$/.exec(value)!;
        assert.ok(match); assert.ok(value.length <= CAP); assert.ok(value.isWellFormed());
        assert.equal(Number(match[2]), offset); text += match[1]; offset = Number(match[3]);
        if (!match[5]) break;
      }
      assert.ok(text.includes(argument)); assert.ok(text.includes(result));
      assert.equal(text.split('ARGUMENT_MIDDLE_123').length - 1, 1);
      assert.equal(text.split('RESULT_MIDDLE_456').length - 1, 1);
      assert.doesNotMatch(text, /PRIVATE_THOUGHT|checkpoint without old evidence|<chat>/);
      return text;
    };
    const before = await allPages();
    assert.equal(unpersistedResultSeen, true, 'message_end listeners can retrieve the result before SDK persistence');
    assert.equal(before.split('Streaming retained reply').length - 1, 1);
    const draft = structuredClone(live.streaming!), after = live.streamingAfter;
    await children.interrupt(id); await until(() => live.info.state === 'paused');
    live.streaming = draft; live.streamingAfter = after;
    assert.equal((await allPages()).split('Streaming retained reply').length - 1, 1, 'a stale draft does not repeat its persisted completion');
    live.streamingAfter = live.session.sessionManager.getEntries().at(-1)!.id;
    assert.equal((await allPages()).split('Streaming retained reply').length - 1, 2, 'an identical new draft after a different boundary is retained');
    live.streaming = undefined; live.streamingAfter = undefined;
    await live.session.prompt('A recent turn before compaction.');
    await live.session.compact();
    assert.ok(compactions > 0);
    assert.ok(live.session.sessionManager.getEntries().some(e => e.type === 'compaction'));
    assert.doesNotMatch(JSON.stringify(live.session.messages), /ARGUMENT_MIDDLE_123|RESULT_MIDDLE_456/, 'the actual Pi working context dropped the old evidence');
    await allPages();
    assert.equal(children.transcript(id, 'unrelated'), undefined);
    await children.tell(id, 'Finish now.');
    await until(() => children.history.records.get(id)?.state === 'completed' && !children.live(id));
    await allPages();
    await children.close();
    children = new Children(memory, registry, choice, () => '', async () => {}, warning => warnings.push(warning), dir, options);
    await allPages();
    await children.tell(id, 'Resume now.');
    await until(() => children.history.records.get(id)?.state === 'completed' && !children.live(id));
    const resumed = await allPages();
    assert.match(resumed, /Resume now\./);
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});
