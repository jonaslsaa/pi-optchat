import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { SUBAGENT_NO_VIEW } from '../src/prompts.ts';
import { readRun } from '../src/run-record.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

// A line only the memory view holds: a child that never sees it got no view.
const SECRET = 'VIEW-ONLY-MARKER the parent noted that passage A leaves Polygonum untranslated';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });
/** Everything a request carried: its task (the first user message's words after the view), system prompt, tool names and full payload text. */
type Request = { task: string; system: string; tools: string[]; payload: string };

async function setup(dir: string, api: 'openai-completions' | 'anthropic-messages', hold = new Set<string>()) {
  const requests: Request[] = [], releases: (() => void)[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api, models: [model('child')],
    streamSimple: (model, context: Context, options) => {
      const first = textContent(context.messages.find(m => m.role === 'user')?.content);
      const task = first.split('Your task:\n').at(-1) ?? '';
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      void (async () => {
        await options?.onPayload?.({ messages: [] }, model); // the request goes out once the payload hooks return
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); return; }
        // Pi sends the system prompt as system messages with sections, and the tools as each message's toolsAdded.
        const messages = context.messages as unknown as { role: string; content?: unknown; sections?: Record<string, string>; toolsAdded?: { name: string }[] }[];
        requests.push({ task, system: messages.filter(m => m.role === 'system').map(m => [textContent(m.content as never), ...Object.values(m.sections ?? {})].join('\n')).join('\n'),
          tools: messages.flatMap(m => (m.toolsAdded ?? []).map(t => t.name)), payload: JSON.stringify(context) });
        if (hold.delete(task)) await new Promise<void>(resolve => { releases.push(resolve); });
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'done', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const memory = new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {});
  memory.append('user', SECRET);
  const make = () => new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'off' }), () => 'USER INSTRUCTIONS', async () => {}, () => {},
    join(dir, 'profile'), { settings: () => ({ subagentLevels: 2, maxAgents: 8 }), createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { requests, release: () => { for (const r of releases.splice(0)) r(); }, make, memory };
}

test("memory 'none': the first request carries the task alone, no view, no zoom/date, and a preamble that describes no view; the default child still gets them", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-blind-'));
  const { requests, make } = await setup(dir, 'openai-completions');
  const children = make();
  try {
    const [blind, plain] = await children.spawn([{ task: 'judge A/B blind', memory: 'none' }, { task: 'with view' }], dir);
    await until(() => !children.active);
    const none = requests.find(r => r.task === 'judge A/B blind')!, view = requests.find(r => r.task === 'with view')!;
    // Check 1: no view text anywhere in what the provider got.
    assert.ok(!none.payload.includes('VIEW-ONLY-MARKER'), 'no view line reaches the provider');
    assert.ok(!none.payload.includes('<chat>'), 'no view at all');
    const first = children.messages(blind).find(m => m.role === 'user');
    assert.equal(textContent(first?.role === 'user' ? first.content : ''), 'judge A/B blind', 'the first message is the task alone');
    // Check 2: no zoom/date/search, and the system prompt does not describe the view.
    for (const name of ['zoom', 'date', 'search']) assert.ok(!none.tools.includes(name), `no ${name} tool`);
    assert.ok(none.tools.includes('tell_parent') && none.tools.includes('spawn'), 'other OptChat tools stay');
    assert.ok(none.system.includes(SUBAGENT_NO_VIEW) && none.system.includes('USER INSTRUCTIONS'));
    assert.doesNotMatch(none.system, /view|zoom/i);
    // Check 3: the default child is unchanged.
    assert.ok(view.payload.includes('VIEW-ONLY-MARKER') && view.tools.includes('zoom') && view.tools.includes('date'));
    assert.match(view.system, /Your first message holds the view below/);
    assert.equal(children.history.records.get(blind)?.memory, 'none');
    assert.equal(children.history.records.get(plain)?.memory, undefined, 'a default run records nothing new');
    assert.equal(readRun(join(dir, 'profile'), blind).memory, 'none', 'saved with the run');
  } finally { await children.close(); removeDir(dir); }
});

test("check 4: on Anthropic, a 'none' sibling is not primed on a view sibling's cache entry, while a same-memory sibling is", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-no-view-cache-'));
  const { requests, release, make } = await setup(dir, 'anthropic-messages', new Set(['first']));
  const children = make();
  try {
    await children.spawn([{ task: 'first' }, { task: 'second' }, { task: 'blind', memory: 'none' }], dir);
    await until(() => requests.length >= 2);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(requests.map(r => r.task).toSorted(), ['blind', 'first'], 'the no-view sibling shares no prefix, so it starts at once; the view sibling waits');
    release();
    await until(() => !children.active);
    assert.deepEqual(requests.map(r => r.task).toSorted(), ['blind', 'first', 'second']);
  } finally { release(); await children.close(); removeDir(dir); }
});

test("check 5: tell resumes a finished 'none' child without the view, after a reload too; its own children get no view either", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-no-view-resume-'));
  const { requests, release, make } = await setup(dir, 'openai-completions', new Set(['parent']));
  let children = make();
  try {
    const [id] = await children.spawn([{ task: 'blind', memory: 'none' }], dir);
    await until(() => !children.active);
    await children.tell(id, 'one more pair');
    await until(() => !children.active && children.history.records.get(id)?.state === 'completed');
    await children.close();
    children = make(); // as /reload does: a new process reads the saved record
    assert.equal(children.history.records.get(id)?.memory, 'none');
    await children.tell(id, 'and another');
    await until(() => !children.active && children.history.records.get(id)?.state === 'completed');
    const blind = requests.filter(r => r.task === 'blind');
    assert.equal(blind.length, 3, 'spawned, resumed, resumed after reload');
    for (const r of blind) {
      assert.ok(!r.payload.includes('VIEW-ONLY-MARKER') && !r.tools.includes('zoom') && !r.tools.includes('date'));
      assert.ok(r.system.includes(SUBAGENT_NO_VIEW));
    }
    // A no-view child can't pass the view on through spawn.
    const [parent] = await children.spawn([{ task: 'parent', memory: 'none' }], dir);
    await until(() => requests.some(r => r.task === 'parent'));
    const [grandchild] = await children.spawn([{ task: 'grandchild' }], dir, undefined, parent);
    await until(() => children.history.records.get(grandchild)?.state === 'completed');
    const g = requests.find(r => r.task === 'grandchild')!;
    assert.equal(children.history.records.get(grandchild)?.memory, 'none');
    assert.ok(!g.payload.includes('VIEW-ONLY-MARKER') && !g.tools.includes('zoom'));
    release();
    await until(() => !children.active);
  } finally { release(); await children.close(); removeDir(dir); }
});

test("check 6: a report to a 'none' parent carries no zoom pointer, since that parent has no zoom tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-no-view-report-'));
  const { requests, release, make } = await setup(dir, 'openai-completions', new Set(['parent']));
  const children = make();
  try {
    const [parent] = await children.spawn([{ task: 'parent', memory: 'none' }], dir);
    await until(() => requests.some(r => r.task === 'parent'));
    const [child] = await children.spawn([{ task: 'child' }], dir, undefined, parent);
    await until(() => children.history.records.get(child)?.state === 'completed');
    release(); // The parent's first request ends, so it reads the report in a second one.
    await until(() => requests.filter(r => r.task === 'parent').length >= 2);
    await until(() => !children.active);
    const report = requests.filter(r => r.task === 'parent')[1];
    assert.ok(report.payload.includes(child), "the parent got its child's report");
    assert.ok(!report.payload.includes('zoom('), 'no pointer to a tool the no-view parent does not have');
  } finally { release(); await children.close(); removeDir(dir); }
});
