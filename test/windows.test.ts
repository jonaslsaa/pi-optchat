import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { createAgentSession, DefaultResourceLoader, type ToolDefinition, SettingsManager, CustomMessageComponent, initTheme, ModelRegistry, ModelRuntime, type ExtensionAPI, type TerminalInputHandler, type ExtensionContext, type MessageRenderer, type Theme } from '@earendil-works/pi-coding-agent';
import { Editor, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, TuiMainScreen, type Component, type Terminal } from '@earendil-works/pi-tui';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { showAgentView } from '../src/agent-view.ts';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { serveWindows, connectWindow, joinHeadless, listAttachableAgents, type WindowEvent } from '../src/window-bridge.ts';
import { profileSocket, lockProfile, createProfile, profilePath } from '../src/profiles.ts';
import { openConnectedWindow, registerConnectedRenderer } from '../src/connected-window.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';
import { HANDOFF_REQUEST } from '../src/prompts.ts';
import { removeDir } from './support.ts';
import { Type } from 'typebox';

/** These tests cover delegation below the first level, which profiles opt into with Subagent levels. */
const nested = () => ({ subagentLevels: 3, maxAgents: 8 });

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(contextWindow = 1_000_000, maxTokens = 64_000) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-window-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const control = { failSummary: false, truncateSummary: false, holdSummary: false, summaryText: 'Handoff: retained the user correction and actual work.',
    window: 'answer' as 'answer' | 'error' | 'empty' | 'tool call, then handoff' | 'stuck tool', releaseTool: () => {} };
  // A tool that ignores the abort: it returns only once the test releases it.
  const stuck: ToolDefinition = { name: 'stuck', label: 'Stuck', description: 'Never cancels.', parameters: Type.Object({}),
    execute: () => new Promise(resolve => { control.releaseTool = () => resolve({ content: [{ type: 'text', text: 'released' }], details: {} }); }) };
  /** Every request's messages as the provider got them, in order; `handoff` marks the window's handoff request. */
  const contexts: { messages: string[]; handoff: boolean }[] = [];
  const requests: string[] = [], summaries: string[] = [], reports: string[] = [], warnings: string[] = [];
  const summaryOptions: { maxTokens?: number; systemPrompt?: string }[] = [];
  runtime.registerProvider('window-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = textContent(last && 'content' in last ? last.content : '');
      const summary = text.includes('Prior handoff:'), handoff = context.messages.some(m => m.role === 'user' && textContent(m.content).startsWith(HANDOFF_REQUEST));
      contexts.push({ messages: context.messages.map(m => JSON.stringify(m)), handoff });
      if (summary) summaries.push(text); else if (!handoff) requests.push(text);
      if (summary) summaryOptions.push({ maxTokens: options?.maxTokens, systemPrompt: textContent(context.messages.find(m => m.role === 'system')?.content) });
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: summary ? control.summaryText : `Reply: ${text.split('Your task:\n').at(-1)}` }],
        api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      if (summary && control.truncateSummary) message.stopReason = 'length';
      if (!summary && text.split('Your task:\n').at(-1) === 'provider-failure') {
        message.stopReason = 'error'; message.errorMessage = 'Synthetic provider error';
        message.content = [{ type: 'text', text: 'PARTIAL_FINAL_TEXT' }];
      }
      if (!summary && last?.role === 'user' && text.includes('descendant-evidence-task')) {
        message.stopReason = 'toolUse';
        message.content = [{ type: 'toolCall', id: 'evidence', name: 'bash', arguments: { command: "printf 'DESCENDANT_TESTS_PASSED_123\\n'" } }];
      }
      if (summary && control.failSummary) { message.stopReason = 'error'; message.errorMessage = 'Synthetic summarizer unavailable'; }
      if (handoff) {
        const checks = control.window === 'tool call, then handoff' && last?.role === 'user';
        message.content = control.window === 'stuck tool' && last?.role === 'user' ? [{ type: 'toolCall', id: 'stuck', name: 'stuck', arguments: {} }]
          : checks ? [{ type: 'text', text: 'Let me check one thing first.' }, { type: 'toolCall', id: 'check', name: 'bash', arguments: { command: "printf 'CHECKED_BEFORE_HANDOFF'" } }]
          : [{ type: 'text', text: control.window === 'empty' ? '' : 'Window handoff: kept the existing API.' }];
        if (message.content.some(block => block.type === 'toolCall')) message.stopReason = 'toolUse';
        if (control.window === 'error') { message.stopReason = 'error'; message.errorMessage = 'Synthetic window error'; }
      }
      if (text === 'spawn one') {
        message.content = [{ type: 'toolCall', id: 'spawn-one', name: 'spawn', arguments: { tasks: [{ task: 'hold work descendant' }] } }];
        message.stopReason = 'toolUse';
      }
      if (last?.role === 'user' && text.split('Your task:\n').at(-1) === 'spawn quick') {
        message.content = [{ type: 'toolCall', id: 'spawn-quick', name: 'spawn', arguments: { tasks: [{ task: 'slow descendant' }] } }];
        message.stopReason = 'toolUse';
      }
      if (!summary && text.split('Your task:\n').at(-1) === 'long reply') message.content = [{ type: 'text', text: `${'x'.repeat(300_000)}END` }];
      if (text === 'ask main') {
        message.content = [{ type: 'toolCall', id: 'tell-main', name: 'tell_parent', arguments: { message: 'Need a decision from the main agent.' } }];
        message.stopReason = 'toolUse';
      }
      void (async () => {
        stream.push({ type: 'start', partial: message });
        const hold = summary || handoff ? control.holdSummary : text.includes('hold work') || last?.role === 'toolResult' && text.includes('DESCENDANT_TESTS_PASSED_123');
        // A held reply is mid-stream, as a real one would be while the model is still writing.
        if (hold) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Reply', partial: message });
        // Outlasts a few window status ticks, so its parent is seen waiting on it.
        if (!summary && text.endsWith('Your task:\nslow descendant')) await new Promise(resolve => setTimeout(resolve, 500));
        if (hold) await new Promise<void>(resolve => {
          if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : message.stopReason === 'length' ? 'length' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime), choice = () => ({ provider: 'window-test', model: 'child', thinking: 'off' as const });
  const ledger = new UsageLedger(dir);
  const summarize = createHandoffSummarizer(registry, choice, reply => ledger.compression(reply, 'compactor', 'owner'));
  const options = { settings: nested, parentSession: 'owner', usage: ledger, summarizeHandoff: summarize, windowHandoffTimeout: undefined as number | undefined,
    createSession: (options: Parameters<typeof createAgentSession>[0]) => createAgentSession({ ...options, modelRuntime: runtime, customTools: [...options?.customTools ?? [], stuck] }) };
  const children = new Children(memory, registry, choice, () => '', async text => { reports.push(text); }, text => warnings.push(text), dir, options);
  const unlock = await lockProfile(dir, 'test owner');
  return { control, contexts, dir, memory, children, requests, summaries, summaryOptions, reports, warnings, registry, runtime, choice, options, ledger,
    async close() { await children.close(); await memory.close(); await unlock(); removeDir(dir); } };
}

test('connected window keeps one real SDK conversation, communicates both ways, and completes its subtree with one handoff', async () => {
  const f = await fixture();
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'Investigate this repository.', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    assert.equal(f.reports.length, 1); assert.match(f.reports[0], /User started/);
    assert.equal(f.children.active, true, 'the conversation remains open between replies');
    await client.request('say', 'Correction: keep the existing API.');
    await until(() => f.children.messages(id).some(m => m.role === 'assistant' && textContent(m.content) === 'Reply: Correction: keep the existing API.'));
    assert.equal(f.children.history.records.size, 1);
    await client.request('tell-main', 'Please coordinate the release.');
    assert.match(f.reports.at(-1) ?? '', /User message.*coordinate the release/);
    await client.request('say', 'ask main');
    await until(() => f.reports.some(text => text.includes('Need a decision')));
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.tell(id, 'Main agent: proceed with tests.');
    await until(() => events.some(e => e.name === 'message' && e.text.includes('Main agent: proceed')));
    assert.deepEqual(events.filter(e => e.from === 'user').map(e => e.text), ['Investigate this repository.', 'Correction: keep the existing API.', 'ask main']);
    assert.equal(events.find(e => e.text.includes('Main agent: proceed'))?.from, undefined, 'main-agent guidance stays boxed');
    assert.ok(!events.some(e => e.name === 'message' && e.text.includes('<chat>')), 'frozen memory must not be rendered as user input');
    await client.request('say', 'hold work');
    await until(() => f.requests.at(-1) === 'hold work');
    const [descendant] = await f.children.spawn([{ task: 'hold work descendant' }], f.dir, undefined, id);
    await client.request('complete');
    await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
    assert.equal(f.children.history.records.get(descendant)?.state, 'stopped');
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
    assert.equal(f.children.history.records.get(id)?.handoff?.delivered, true);
    assert.match(f.reports.at(-1) ?? '', /completed by user/);
    assert.equal(f.summaries.length, 1);
    assert.match(f.summaries[0], /Correction: keep the existing API/);
    assert.match(f.summaries[0], /Main agent: proceed/);
    assert.doesNotMatch(f.summaries[0], /<chat>/);
    assert.equal(f.ledger.entries.filter(entry => entry.role === 'compactor').length, 1);
    await assert.rejects(client.request('say', 'Too late'), /closing/);
    await f.children.recoverHandoffs();
    assert.equal(f.summaries.length, 1, 'delivered handoffs must not be repeated');
    assert.match(f.warnings.join("\n"), /could not write its own handoff, so the compactor writes it: Synthetic window error/);
  } finally { client.close(); await close(); await f.close(); }
});

test('deleting a connected conversation from the Agents page ends its window', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'Investigate this repository.', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.remove(id);
    await until(() => events.some(e => e.name === 'finished'));
    assert.match(events.find(e => e.name === 'finished')?.text ?? '', /deleted from the Agents page/);
    await assert.rejects(client.request('say', 'Still there?'), /closing/);
  } finally { client.close(); await close(); await f.close(); }
});

test('connected window receives the real tool calls, results and live state, so it can draw them like Pi', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'descendant-evidence-task', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    // The fake model calls bash, then holds its next reply open, so the window sees a streaming reply.
    await until(() => events.some(e => e.message?.role === 'toolResult'));
    const call = events.find(e => e.message?.role === 'assistant')?.message;
    assert.ok(call?.role === 'assistant' && call.content.some(p => p.type === 'toolCall' && p.name === 'bash' && p.id === 'evidence'));
    const result = events.find(e => e.message?.role === 'toolResult')?.message;
    assert.ok(result?.role === 'toolResult' && result.toolCallId === 'evidence' && textContent(result.content).includes('DESCENDANT_TESTS_PASSED_123'));
    await until(() => events.some(e => e.live?.streaming));
    const live = events.findLast(e => e.live)?.live;
    assert.equal(live?.state, 'running'); assert.equal(live?.model, 'window-test/child');
    await f.children.spawn([{ task: 'hold work descendant' }], f.dir, undefined, id);
    await until(() => events.some(e => e.live?.agents === 1));
  } finally { client.close(); await close(); await f.close(); }
});

test("a headless run joins a busy profile: it gets the final reply after the agent's own agents report, and main gets the handoff", async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  try {
    const joined = await joinHeadless(f.dir);
    const reply = await joined.ask('spawn quick', f.dir);
    // The agent spawns a slow child and waits for it, then answers with its report; only that last answer is the reply.
    assert.match(reply, /^Reply: .*Reply: slow descendant/s);
    const [id] = [...f.children.history.records.values()].filter(run => run.connected).map(run => run.id);
    await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
    assert.match(f.reports.at(-1) ?? '', /completed by user/);
    await assert.rejects(joined.ask('again', f.dir), /one request/);
    // Window events cut long text for display; the printed reply is never cut.
    assert.equal(await (await joinHeadless(f.dir)).ask('long reply', f.dir), `${'x'.repeat(300_000)}END`);
  } finally { await close(); await f.close(); }
});

test('a headless join fails visibly: no running session, or a provider error instead of a reply', async () => {
  const f = await fixture();
  try {
    await assert.rejects(joinHeadless(f.dir), /No running OptChat session/);
    const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
    try {
      const joined = await joinHeadless(f.dir);
      await assert.rejects(joined.ask('provider-failure', f.dir), /Synthetic provider error/);
    } finally { await close(); }
  } finally { await f.close(); }
});

initTheme('dark', false);
class OffscreenTerminal implements Terminal {
  start() {} stop() {} async drainInput() {} write() {}
  get columns() { return 100; } get rows() { return 30; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');

test('a connected window draws each reply with its tool results, the live turn, Working vs Waiting for N agents, and your queued messages', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-home-'));
  createProfile('draw');
  const close = await serveWindows(profilePath('draw'), f.children, () => true, async text => { f.reports.push(text); });
  const tui = new TuiMainScreen(new OffscreenTerminal());
  const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  let renderer: MessageRenderer | undefined, widget: (Component & { dispose?(): void }) | undefined;
  const sent: { content: unknown; details?: { from?: string; turn?: unknown[] } }[] = [];
  const pi = { registerMessageRenderer: (_type: string, r: MessageRenderer) => { renderer = r; }, sendMessage: (m: typeof sent[number]) => { sent.push(m); } } as unknown as ExtensionAPI;
  registerConnectedRenderer(pi);
  let keys: TerminalInputHandler | undefined, editorText = '';
  const ctx = { cwd: f.dir, shutdown() {}, ui: { setStatus() {}, notify() {}, setWorkingMessage() {}, setTitle() {},
    onTerminalInput: (handler: TerminalInputHandler) => { keys = handler; return () => {}; },
    getEditorText: () => editorText, setEditorText: (text: string) => { editorText = text; },
    setWidget: (_key: string, factory?: (tui: TuiMainScreen, theme: Theme) => Component) => { widget?.dispose?.(); widget = factory?.(tui, plainTheme); } } } as unknown as ExtensionContext;
  // What the chat shows for a committed message, drawn through the registered renderer as Pi would.
  const chat = (message: typeof sent[number]) => plain(new CustomMessageComponent({ role: 'custom', customType: 'optchat-connected', content: message.content as string,
    display: true, details: message.details, timestamp: 1 }, renderer).render(100));
  const live = () => widget ? plain(widget.render(100)) : '';
  const turns = () => sent.filter(m => m.details?.turn);
  // A turn restored before any window is live (after /reload) still draws as a tool box, not plain text.
  const restored = { content: '', details: { from: 'agent', turn: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'bash', arguments: { command: 'echo restored' } }], api: 'x', provider: 'x', model: 'x', usage: emptyUsage(), stopReason: 'toolUse', timestamp: 1 },
    { role: 'toolResult', toolCallId: 'old', toolName: 'bash', content: [{ type: 'text', text: 'RESTORED_OUTPUT' }], isError: false, timestamp: 2 },
  ] } };
  assert.match(chat(restored), /\$ echo restored[\s\S]*RESTORED_OUTPUT/);
  const window = await openConnectedWindow(pi, ctx, 'draw');
  try {
    await window.submit('Investigate this repository.');
    const id = [...f.children.history.records.keys()][0]; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting' && turns().length === 1);
    assert.match(chat(turns()[0]), /Reply: Investigate this repository\./);
    await until(() => !/Working|Waiting/.test(live()));

    // A tool OptChat provides is drawn like a registered tool, on one line with its result, not as raw JSON.
    await window.submit('ask main');
    await until(() => turns().length >= 2);
    const asked = chat(turns()[1]);
    assert.match(asked, /tell_parent message="Need a decision from the main agent\."/);
    assert.match(asked, /Message sent to the main agent/);
    assert.doesNotMatch(asked, /^\s*"message":/m);
    await until(() => f.children.history.records.get(id)?.state === 'waiting' && turns().length >= 3);

    // Waiting on its own agent spins with a count; waiting on you does not spin at all.
    await window.submit('spawn one');
    await until(() => /Waiting for 1 agent/.test(live()));

    // The live turn shows the streaming reply under the spinner; the finished bash call settles into the chat with its output.
    await window.submit('descendant-evidence-task');
    await until(() => /Working/.test(live()) && /Reply/.test(live()));
    const bash = turns().map(chat).find(text => text.includes('printf'));
    assert.ok(bash, 'the bash call is in the chat');
    assert.match(bash, /DESCENDANT_TESTS_PASSED_123/, 'a reply and its tool results are one chat entry');

    // While it works, what you send shows under the spinner at once. At the editor, Alt+Up takes the newest back,
    // and Esc interrupts the agent, which goes on with the rest, now shown as yours in the chat.
    setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, 'app.interrupt': { defaultKeys: 'escape' }, 'app.message.dequeue': { defaultKeys: 'alt+up' } }));
    tui.setFocus(new Editor(tui, { borderColor: text => text, selectList: { selectedPrefix: t => t, selectedText: t => t, description: t => t, scrollInfo: t => t, noMatch: t => t } }));
    await window.submit('first steer'); await window.submit('second steer');
    await until(() => /Steering: first steer\s+Steering: second steer/.test(live()));
    assert.deepEqual(keys?.('\x1b[1;3A'), { consume: true });
    await until(() => editorText === 'second steer' && !/second steer/.test(live()));
    assert.deepEqual(keys?.('\x1b'), { consume: true });
    await until(() => !/Steering/.test(live()) && sent.some(m => m.details?.from === 'user' && /first steer/.test(String(m.content))));
    assert.equal(f.children.history.records.get(id)?.guidance.some(g => g.text === 'second steer'), false);
  } finally {
    widget?.dispose?.();
    window.close(); await close(); await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('a connected window titles its tab: waiting, working, done, and disconnected', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-home-'));
  createProfile('win');
  const close = await serveWindows(profilePath('win'), f.children, () => true, async text => { f.reports.push(text); });
  const titles: string[] = [];
  let closed = false;
  const pi = { sendMessage() {} } as unknown as ExtensionAPI;
  const ctx = (into: string[]) => ({ cwd: f.dir, shutdown() {},
    ui: { setStatus() {}, setWidget() {}, notify() {}, setWorkingMessage() {}, onTerminalInput: () => () => {}, setTitle: (title: string) => into.push(title) } }) as unknown as ExtensionContext;
  try {
    const window = await openConnectedWindow(pi, ctx(titles), 'win');
    assert.deepEqual(titles, ['↳ win']);
    await window.submit('Investigate this repository.');
    await until(() => titles.at(-1) === '↳ win' && titles.includes('● ↳ win'));
    assert.deepEqual(titles.filter((t, i) => t !== titles[i - 1]), ['↳ win', '● ↳ win', '↳ win'], 'working while the child runs, waiting once it replies');
    await window.complete();
    assert.equal(titles.at(-1), '↳ win · done');

    const other: string[] = [];
    await openConnectedWindow(pi, ctx(other), 'win');
    await close(); closed = true;
    await until(() => other.at(-1) === '↳ win · disconnected');
  } finally {
    if (!closed) await close();
    await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('SIGKILL of the client interrupts owner-hosted work and reports it', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createConnection} from 'node:net';
    const socket = createConnection(process.argv[1]);
    socket.on('connect', () => socket.write(JSON.stringify({kind:'request',id:1,action:'start',text:'hold work',cwd:process.argv[2]})+'\\n'));
    socket.on('data', () => {});
  `, profileSocket(f.dir, 'windows'), f.dir], { stdio: 'ignore' });
  try {
    await until(() => f.requests.some(text => text.includes('hold work')));
    child.kill('SIGKILL');
    await until(() => f.reports.some(text => text.includes('interrupted (disconnected)')));
    assert.equal(f.children.active, false);
    assert.equal(f.children.history.list()[0].handoff?.delivered, true);
  } finally { child.kill('SIGKILL'); await close(); await f.close(); }
});

test('pending handoffs survive failed delivery and restart without another model call', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Remember the user correction.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.finish(id, 'complete');
    const run = f.children.history.records.get(id)!;
    // Simulate the durable state left by an owner crash before producing its handoff.
    run.state = 'waiting'; run.handoff = undefined; f.children.history.save(run);
    const failing = new Children(f.memory, f.registry, f.choice, () => '', async () => { throw new Error('delivery unavailable'); }, () => {}, f.dir, f.options);
    await assert.rejects(failing.recoverHandoffs(), /delivery unavailable/);
    const calls = f.contexts.length;
    const recovered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { recovered.push(text); }, () => {}, f.dir, f.options);
    await restored.recoverHandoffs(); await restored.recoverHandoffs();
    assert.equal(recovered.length, 1); assert.match(recovered[0], /owner-stopped/);
    assert.equal(f.contexts.length, calls);
    await failing.close(); await restored.close();
  } finally { await f.close(); }
});

test('closing the owner leaves a connected handoff for the next start instead of waiting on its summary', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  const restart = (reports: string[] = []) => new Children(f.memory, f.registry, f.choice, () => '', async text => { reports.push(text); }, () => {}, f.dir, f.options);
  try {
    await client.request('start', 'Investigate this repository.', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    // What /reload does: the window ends as owner-stopped, without a summary.
    f.children.deferHandoffs(); await close();
    assert.ok(!f.contexts.some(c => c.handoff));
    assert.deepEqual(f.children.history.records.get(id)?.handoff, { reason: 'owner-stopped' });

    // The next start's recovery is aborted by another quick /reload, still leaving the handoff undelivered.
    f.control.holdSummary = true;
    const interrupted = restart();
    const recovery = interrupted.recoverHandoffs();
    await until(() => f.contexts.some(c => c.handoff));
    interrupted.deferHandoffs(); await recovery; await interrupted.close();
    assert.deepEqual(interrupted.history.records.get(id)?.handoff, { reason: 'owner-stopped' }, 'no fallback written, nothing delivered');

    f.control.holdSummary = false;
    const delivered: string[] = [];
    const restored = restart(delivered);
    await restored.recoverHandoffs(); await restored.recoverHandoffs();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /interrupted \(owner-stopped\)\.[^]*Window handoff: kept the existing API/);
    assert.equal(f.summaries.length, 0);
    await restored.close();
  } finally { client.close(); await f.close(); }
});

test('disconnect during startup cancels cleanly, and importing owners reject new work', async () => {
  const f = await fixture();
  let available = false;
  const close = await serveWindows(f.dir, f.children, () => available, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, () => {}, () => {});
  try {
    await assert.rejects(client.request('start', 'hello', f.dir), /importing/);
    assert.equal(f.children.history.records.size, 0);
    available = true;
    const start = client.request('start', 'hello', f.dir);
    client.close();
    await assert.rejects(start, /lost/);
    await close();
    assert.equal(f.children.active, false);
  } finally { client.close(); await f.close(); }
});


test('long handoffs fold all transcript chunks, and a failed summarizer still reports an honest fallback', async () => {
  const f = await fixture();
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const info = f.children.history.records.get(id)!;
    const longCorrection = 'Original detail. 🧠 '.repeat(70_000) + ' FINAL USER CORRECTION';
    f.control.summaryText = 'Handoff: ' + 'Important detail. '.repeat(3000);
    const text = await f.options.summarizeHandoff(info, [
      { role: 'user', content: '<chat>PRIVATE MEMORY VIEW</chat>\n\nYour task:\nInitial task', timestamp: 1 },
      { role: 'user', content: longCorrection, timestamp: 2 },
    ]);
    assert.ok(f.summaries.length >= 3);
    assert.ok(f.summaries.some(chunk => chunk.includes('FINAL USER CORRECTION')));
    assert.ok(f.summaries.every(chunk => !chunk.includes('PRIVATE MEMORY VIEW')));
    const evidence = f.summaries.map(request => request.split('\nNext transcript chunk:\n')[1]).join('');
    assert.ok(evidence.includes(longCorrection), 'chunking must preserve all evidence, including Unicode at boundaries');
    for (const [i, request] of f.summaries.entries()) {
      const inputBytes = Buffer.byteLength(request) + Buffer.byteLength(f.summaryOptions[i].systemPrompt!);
      assert.ok(inputBytes / 4 <= 128_000, 'the prior handoff and instructions count toward the input budget');
      if (i) assert.ok(request.includes(f.control.summaryText.trim()), 'each call includes the full prior summary');
    }
    assert.equal(text, f.control.summaryText.trim(), 'useful detail beyond the old word limit is retained');
    assert.match(text, /Handoff:/);
    f.control.failSummary = true;
    await f.children.finish(id, 'disconnected');
    assert.match(f.reports.at(-1) ?? '', /interrupted \(disconnected\)/);
    assert.match(f.reports.at(-1) ?? '', /Automatic summary unavailable.*Synthetic summarizer unavailable/);
    assert.doesNotMatch(f.reports.at(-1) ?? '', /Stopped by the user|tell resumes it/, 'a window that ends is not stopped by the user, and resume refuses connected runs');
    assert.match(f.reports.at(-1) ?? '', /Full transcript:/);
    assert.equal(info.handoff?.delivered, true);
  } finally { await f.close(); }
});

test('a transcript below the handoff budget is summarized in one call with a larger output allowance', async () => {
  const f = await fixture();
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const detail = 'Complete evidence. '.repeat(25_000);
    await f.options.summarizeHandoff(f.children.history.records.get(id)!, [
      { role: 'user', content: 'Initial task', timestamp: 1 },
      { role: 'user', content: detail, timestamp: 2 },
    ]);
    assert.equal(f.summaries.length, 1);
    assert.ok(f.summaries[0].includes(detail));
    assert.equal(f.summaryOptions[0].maxTokens, 16_000);
  } finally { await f.close(); }
});

test('handoffs respect smaller model windows and output limits while retaining all evidence', async () => {
  const f = await fixture(32_000, 2048);
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const detail = 'Smaller model evidence. '.repeat(10_000);
    await f.options.summarizeHandoff(f.children.history.records.get(id)!, [
      { role: 'user', content: 'Initial task', timestamp: 1 },
      { role: 'user', content: detail, timestamp: 2 },
    ]);
    assert.ok(f.summaries.length > 1);
    assert.ok(f.summaries.map(request => request.split('\nNext transcript chunk:\n')[1]).join('').includes(detail));
    for (const [i, request] of f.summaries.entries()) {
      const options = f.summaryOptions[i];
      assert.equal(options.maxTokens, 2048);
      assert.ok((Buffer.byteLength(request) + Buffer.byteLength(options.systemPrompt!)) / 4 + options.maxTokens <= 32_000 * 0.8);
    }
  } finally { await f.close(); }
});

test('a handoff truncated by the output limit reports a fallback instead of claiming to be complete', async () => {
  const f = await fixture();
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    f.control.truncateSummary = true;
    await f.children.finish(id, 'complete');
    assert.match(f.reports.at(-1) ?? '', /Automatic summary unavailable.*output limit/);
    assert.match(f.reports.at(-1) ?? '', /Full transcript:/);
    assert.equal(f.children.history.records.get(id)?.handoff?.delivered, true);
  } finally { await f.close(); }
});

test('recovery leaves newly started conversations to their own completion path', async () => {
  const f = await fixture();
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  let releaseOld = () => {}, releaseNew = () => {};
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
  try {
    const [old] = await f.children.spawn([{ task: 'Earlier interrupted session' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(old)?.state === 'waiting');
    await f.children.finish(old, 'complete');
    const oldInfo = f.children.history.records.get(old)!;
    oldInfo.handoff = undefined; oldInfo.state = 'interrupted'; f.children.history.save(oldInfo);
    const calls: string[] = [];
    f.options.summarizeHandoff = async run => {
      calls.push(run.id); const serial = calls.length;
      await (run.id === old ? oldGate : newGate);
      return `Summary from call ${serial}`;
    };
    let recovered = false;
    const recovery = f.children.recoverHandoffs().then(() => { recovered = true; });
    await until(() => calls.includes(old));
    const [fresh] = await f.children.spawn([{ task: 'New connected session' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(fresh)?.state === 'waiting');
    const finish = f.children.finish(fresh, 'complete');
    await until(() => calls.includes(fresh));
    releaseOld();
    await until(() => recovered || calls.filter(id => id === fresh).length > 1);
    assert.equal(recovered, true, 'recovery must finish while the new conversation is still summarizing');
    assert.equal(calls.filter(id => id === fresh).length, 1);
    releaseNew();
    await Promise.all([finish, recovery]);
    assert.equal(f.reports.filter(text => text.startsWith(`[${fresh}] Connected conversation`)).length, 1);
  } finally { releaseOld(); releaseNew(); await f.close(); }
});

test('handoffs include stopped descendant evidence at every depth, including after restart', async () => {
  const f = await fixture();
  // The compactor's handoff: the window fails to write its own.
  f.control.window = 'error';
  try {
    const [parent] = await f.children.spawn([{ task: 'hold work parent' }], f.dir, undefined, undefined, true);
    await until(() => f.requests.some(text => text.includes('hold work parent')));
    const [child] = await f.children.spawn([{ task: 'hold work child' }], f.dir, undefined, parent);
    await until(() => f.requests.some(text => text.includes('hold work child')));
    const [grandchild] = await f.children.spawn([{ task: 'descendant-evidence-task' }], f.dir, undefined, child);
    await until(() => f.requests.some(text => text.includes('DESCENDANT_TESTS_PASSED_123')));
    await f.children.finish(parent, 'complete');
    assert.ok(f.children.messages(grandchild).some(m => m.role === 'toolResult' && textContent(m.content).includes('DESCENDANT_TESTS_PASSED_123')));
    const root = f.children.history.records.get(parent)!, childRun = f.children.history.records.get(child)!, grandchildRun = f.children.history.records.get(grandchild)!;
    const checkEvidence = (handoff: string) => {
      assert.match(f.summaries.join('\n'), /TOOL RESULT \(bash, error=false\): DESCENDANT_TESTS_PASSED_123/);
      assert.ok(f.summaries.join('\n').includes(`AGENT ${grandchild} · parent ${child} · stopped`));
      assert.ok(handoff.includes(grandchildRun.sessionFile!));
      assert.ok(handoff.includes(`[${child}] stopped · parent ${parent}`));
    };
    checkEvidence(root.handoff!.text!);

    // Recovery must use persisted relationships, and one missing transcript must not hide the others.
    root.state = 'waiting'; root.handoff = undefined; f.children.history.save(root);
    unlinkSync(childRun.sessionFile!); f.summaries.length = 0;
    const recovered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { recovered.push(text); }, () => {}, f.dir, f.options);
    try {
      await restored.recoverHandoffs();
      assert.equal(recovered.length, 1); checkEvidence(recovered[0]);
      assert.ok(recovered[0].includes(`No transcript available. Run metadata: ${join(f.dir, 'runs', `${child}.optchat.json`)}`));
    } finally { await restored.close(); }
  } finally { await f.close(); }
});

for (const scenario of ['before-first-tick', 'after-reply', 'missing-transcript'] as const) {
  test(`provider failure drains terminal messages before finishing (${scenario})`, async t => {
    const f = await fixture();
    const events: WindowEvent[] = [];
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    const interval = t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
      if (delay === 150) { tick = callback; return originalInterval(() => {}, 10000); }
      return originalInterval(callback, delay);
    });
    const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
    const client = await connectWindow(f.dir, event => events.push(event), () => {});
    // The server's connection handler runs on a later tick, so the mock must stay installed until it has captured the status timer.
    await until(() => tick !== undefined);
    interval.mock.restore();
    try {
      await client.request('start', scenario === 'after-reply' ? 'Hello' : 'provider-failure', f.dir);
      const id = events.find(e => e.name === 'started')?.text; assert.ok(id); assert.ok(tick);
      if (scenario === 'after-reply') {
        await until(() => f.children.history.records.get(id)?.state === 'waiting');
        tick(); await until(() => events.filter(e => e.name === 'message').length === 2);
        await client.request('say', 'provider-failure');
      }
      await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
      assert.ok(f.children.messages(id).some(m => m.role === 'assistant' && textContent(m.content).includes('PARTIAL_FINAL_TEXT')));
      if (scenario === 'missing-transcript') unlinkSync(f.children.history.records.get(id)!.sessionFile!);
      tick();
      await until(() => events.some(e => e.name === 'finished'));
      const messages = events.filter(e => e.name === 'message');
      if (scenario !== 'missing-transcript') {
        assert.equal(messages.filter(e => e.from === 'agent' && e.text === 'PARTIAL_FINAL_TEXT').length, 1);
        assert.equal(messages.filter(e => e.from === 'user' && e.text === 'provider-failure').length, 1);
        assert.equal(messages.length, scenario === 'after-reply' ? 4 : 2);
        assert.equal(events.at(-1)?.name, 'finished');
        assert.ok(!messages.some(e => e.text.includes('<chat>')));
      }
      tick();
      assert.equal(events.filter(e => e.name === 'finished').length, 1);
    } finally { interval.mock.restore(); client.close(); await close(); await f.close(); }
  });
}

test('attaching borrows an existing background session without spawning, changing its parent or claiming its lifetime', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const [id] = await f.children.spawn([{ task: 'hold work original background' }], f.dir);
  await until(() => !!f.children.live(id)?.streaming);
  const original = f.children.live(id)!.session;
  const client = await connectWindow(f.dir, e => events.push(e), () => {});
  try {
    await client.request('attach', id);
    assert.equal(events.find(e => e.name === 'started')?.text, id);
    assert.equal(f.children.history.records.size, 1);
    assert.equal(f.children.live(id)?.session, original);
    assert.equal(f.children.history.records.get(id)?.connected, undefined);
    assert.equal(f.children.history.records.get(id)?.parentId, undefined);
    await until(() => events.some(e => e.live?.streaming));
    assert.deepEqual(events.filter(e => e.from === 'user').map(e => e.text), ['hold work original background']);
    assert.ok(!events.some(e => e.text.includes('<chat>')));
    await client.request('say', 'Finish with evidence.');
    assert.equal(f.children.history.records.get(id)?.guidance.at(-1)?.from, 'user');
    await client.request('tell-main', 'I am reviewing this existing agent.');
    assert.match(f.reports.at(-1) ?? '', /User message.*reviewing this existing agent/);
    await client.request('complete');
    await until(() => events.some(e => e.name === 'finished'));
    assert.match(events.find(e => e.name === 'finished')?.text ?? '', /Detached/);
    assert.equal(f.children.live(id)?.session, original);
    assert.equal(f.children.history.records.get(id)?.state, 'running');
    assert.equal(f.summaries.length, 0, 'detaching must not create a handoff');
    assert.ok(!f.reports.some(t => t.includes('User started')));
    await assert.rejects(client.request('say', 'Too late'), /closing/);
  } finally { client.close(); await close(); await f.close(); }
});

test('closing an attached socket leaves background work running and allows reconnection', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'hold work survives detach' }], f.dir);
  const one = await connectWindow(f.dir, () => {}, () => {});
  try {
    await one.request('attach', id); one.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.children.history.records.get(id)?.state, 'running');
    assert.equal(f.children.history.records.get(id)?.handoff, undefined);
    const events: WindowEvent[] = [];
    const two = await connectWindow(f.dir, e => events.push(e), () => {});
    try {
      await two.request('attach', id);
      await until(() => events.some(e => e.live?.streaming));
      assert.equal(f.children.history.records.size, 1);
      assert.equal(events.find(e => e.name === 'started')?.text, id);
    } finally { two.close(); }
  } finally { one.close(); await close(); await f.close(); }
});

test('attachment replays real tool results and follows a paused background agent through its ordinary parent report', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const [id] = await f.children.spawn([{ task: 'descendant-evidence-task' }], f.dir);
  await until(() => !!f.children.live(id)?.streaming && f.children.live(id)!.session.messages.some(m => m.role === 'toolResult'));
  await f.children.interrupt(id);
  await until(() => f.children.history.records.get(id)?.state === 'paused');
  const client = await connectWindow(f.dir, e => events.push(e), () => {});
  try {
    await client.request('attach', id);
    await until(() => events.some(e => e.live?.state === 'paused'));
    assert.ok(events.some(e => e.message?.role === 'toolResult' && textContent(e.message.content).includes('DESCENDANT_TESTS_PASSED_123')));
    await client.request('say', 'User: finish the original task.');
    await until(() => events.some(e => e.name === 'finished'));
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
    assert.equal(f.children.history.records.get(id)?.handoff, undefined);
    assert.ok(f.reports.some(t => t.includes(`[${id}]`) && t.includes('finish the original task')));
    assert.ok(events.some(e => e.from === 'agent' && e.text.includes('finish the original task')));
    assert.equal(f.summaries.length, 0);
    await f.children.tell(id, 'hold work resumed by parent');
    const second = await connectWindow(f.dir, () => {}, () => {});
    try { await second.request('attach', id); }
    finally { second.close(); }
  } finally { client.close(); await close(); await f.close(); }
});

test('a finished background transcript opens without a model call or implicit resume', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'Historical background result' }], f.dir);
  await until(() => !f.children.live(id));
  const calls = f.requests.length, reports = f.reports.length;
  const client = await connectWindow(f.dir, e => events.push(e), () => {});
  try {
    await client.request('attach', id);
    await until(() => events.some(e => e.name === 'finished'));
    assert.ok(events.some(e => e.from === 'agent' && e.text.includes('Historical background result')));
    assert.equal(f.requests.length, calls);
    assert.equal(f.reports.length, reports);
    assert.equal(f.children.history.records.size, 1);
    await assert.rejects(client.request('say', 'Resume silently'), /closing/);
  } finally { client.close(); await close(); await f.close(); }
});

test('attach rejects unknown IDs, invalid IDs, an importing owner, and conversations owned by another connected window', async () => {
  const f = await fixture();
  let available = true;
  const close = await serveWindows(f.dir, f.children, () => available, async () => {});
  const client = await connectWindow(f.dir, () => {}, () => {});
  const [id] = await f.children.spawn([{ task: 'hold work existing' }], f.dir);
  try {
    await assert.rejects(client.request('attach', '../../outside'), /exact agent ID/);
    await assert.rejects(client.request('attach', 'missing'), /No subagent missing/);
    await assert.rejects(client.request('attach', id.slice(0, 4)), /No subagent/, 'only exact IDs, never ambiguous prefixes');
    available = false;
    await assert.rejects(client.request('attach', id), /importing/);
    available = true;
    const [connected] = await f.children.spawn([{ task: 'Another window owns this' }], f.dir, undefined, undefined, true);
    await assert.rejects(client.request('attach', connected), /belongs to a connected window/);
    await client.request('attach', id);
    await assert.rejects(client.request('start', 'Accidental new agent', f.dir), /already has/);
    await assert.rejects(client.request('attach', id), /already has/);
    assert.equal(f.children.history.records.size, 2);
  } finally { client.close(); await close(); await f.close(); }
});

test('deleting an attached background agent closes the view without changing ordinary deletion semantics', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'hold work to delete' }], f.dir);
  const client = await connectWindow(f.dir, e => events.push(e), () => {});
  try {
    await client.request('attach', id);
    await f.children.remove(id);
    await until(() => events.some(e => e.name === 'finished'));
    assert.match(events.find(e => e.name === 'finished')?.text ?? '', /deleted/);
    assert.equal(f.children.history.records.has(id), false);
  } finally { client.close(); await close(); await f.close(); }
});

test('SIGKILL of an attached terminal does not stop its existing background session', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'hold work survives killed terminal' }], f.dir);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createConnection} from 'node:net';
    const socket = createConnection(process.argv[1]);
    socket.on('connect', () => socket.write(JSON.stringify({kind:'request',id:1,action:'attach',text:process.argv[2]})+'\\n'));
    socket.on('data', () => process.stdout.write('attached\\n'));
  `, profileSocket(f.dir, 'windows'), id], { stdio: ['ignore', 'pipe', 'ignore'] });
  let attached = false; child.stdout.on('data', () => { attached = true; });
  try {
    await until(() => attached);
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.children.history.records.get(id)?.state, 'running');
    assert.ok(f.children.live(id));
    assert.equal(f.children.history.records.get(id)?.handoff, undefined);
    assert.equal(f.reports.length, 0);
  } finally { child.kill('SIGKILL'); await close(); await f.close(); }
});

test('the normal Pi extension CLI attaches directly, saves no profile binding, routes input, and shutdown only detaches', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-cli-home-'));
  createProfile('attach');
  const close = await serveWindows(profilePath('attach'), f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'hold work CLI existing session' }], f.dir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: join(f.dir, 'client-agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const { session } = await createAgentSession({ modelRuntime: f.runtime, model: f.registry.find('window-test', 'child'),
    resourceLoader: loader, settingsManager, tools: [] });
  const errors: string[] = [];
  session.extensionRunner.setFlagValue('optchat-profile', 'attach');
  session.extensionRunner.setFlagValue('optchat-agent', id);
  const ui = { ...session.extensionRunner.getUIContext(), select: async () => { throw new Error('Direct attachment must not ask to spawn a connected agent'); } };
  try {
    await session.bindExtensions({ uiContext: ui, mode: 'tui', onError: error => errors.push(error.error) });
    assert.deepEqual(errors, []);
    assert.equal(session.sessionManager.getEntries().some(e => e.type === 'custom' && e.customType === 'optchat.profile'), false);
    assert.equal(f.children.history.records.size, 1);
    const taskCopies = () => session.sessionManager.getEntries().filter(e => e.type === 'custom_message' && e.customType === 'optchat-connected' && e.content === 'hold work CLI existing session').length;
    await until(() => taskCopies() === 1);
    await session.prompt('CLI guidance for the original agent.');
    assert.equal(f.children.history.records.get(id)?.guidance.at(-1)?.text, 'CLI guidance for the original agent.');
    assert.equal(f.children.history.records.get(id)?.guidance.at(-1)?.from, 'user');
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.children.history.records.get(id)?.state, 'running');
    assert.equal(f.children.history.records.get(id)?.handoff, undefined);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await close(); await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('a large finished transcript replays in bounded batches before the attached view ends', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'Large historical background task' }], f.dir);
  await until(() => !f.children.live(id));
  const originalMessages = f.children.messages.bind(f.children);
  const messages = originalMessages(id);
  for (let i = 0; i < 150; i++) messages.push({ role: 'toolResult', toolCallId: `history-${i}`, toolName: 'bash',
    content: [{ type: 'text', text: `${i}: ${'x'.repeat(40_000)}` }], isError: false, timestamp: i });
  f.children.messages = run => run === id ? messages : originalMessages(run);
  let disconnected = false;
  const client = await connectWindow(f.dir, e => events.push(e), () => { disconnected = true; });
  try {
    await client.request('attach', id);
    await until(() => events.some(e => e.name === 'finished'));
    assert.equal(disconnected, false, 'more than 4 MB of history must not overflow the socket');
    assert.equal(events.filter(e => e.message?.role === 'toolResult').length, 150);
    assert.equal(events.at(-1)?.name, 'finished', 'finish follows the entire replay, not only the first batch');
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
  } finally { client.close(); await close(); await f.close(); }
});

test('the owner lists live background agents, including ones already open in another view', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [one, two] = await f.children.spawn([{ task: 'hold work one' }, { task: 'hold work two' }], f.dir);
  const [done] = await f.children.spawn([{ task: 'Finished history is not a menu option' }], f.dir);
  const [connected] = await f.children.spawn([{ task: 'Owned connected conversation' }], f.dir, undefined, undefined, true);
  await until(() => !f.children.live(done));
  const calls = f.requests.length;
  const client = await connectWindow(f.dir, () => {}, () => {});
  try {
    const initial = await listAttachableAgents(f.dir);
    assert.deepEqual(new Set(initial.map(a => a.id)), new Set([one, two]));
    assert.ok(initial.every(a => a.task.startsWith('hold work') && a.state === 'running'));
    await client.request('attach', one);
    assert.deepEqual(new Set((await listAttachableAgents(f.dir)).map(a => a.id)), new Set([one, two]));
    await client.request('complete');
    assert.equal(f.requests.length, calls, 'listing and selecting must not call a model');
    assert.equal(f.children.history.records.size, 4);
    assert.equal(f.children.history.records.get(connected)?.connected, true);
    assert.equal(f.children.history.records.get(one)?.state, 'running');
  } finally { client.close(); await close(); await f.close(); }
});

test('views coexist: the main inspector and two terminals open the same agent, and each can steer it', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'hold work shared views' }], f.dir);
  const events: WindowEvent[][] = [[], []];
  const clients = await Promise.all(events.map(list => connectWindow(f.dir, e => list.push(e), () => {})));
  const { promise: dismissed, resolve: dismiss } = Promise.withResolvers<void>();
  const ctx = { ui: { custom: async () => { await dismissed; } } } as unknown as ExtensionContext;
  const view = showAgentView(ctx, { id, children: f.children });
  try {
    await Promise.all(clients.map(c => c.request('attach', id)));
    assert.ok(events.every(list => list.find(e => e.name === 'started')?.text === id));
    assert.equal((await listAttachableAgents(f.dir))[0]?.id, id);
    await clients[0].request('say', 'From the first terminal.');
    await clients[1].request('say', 'From the second terminal.');
    assert.deepEqual(f.children.history.records.get(id)?.guidance.map(g => g.text).slice(-2), ['From the first terminal.', 'From the second terminal.']);
    assert.equal(f.children.history.records.size, 1);
    assert.equal(f.children.history.records.get(id)?.state, 'running');
  } finally { dismiss(); await view; clients.forEach(c => c.close()); await close(); await f.close(); }
});

async function menuClient(f: Awaited<ReturnType<typeof fixture>>, name: string,
  select: (title: string, options: string[]) => Promise<string | undefined>) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: join(f.dir, 'menu-client'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const { session } = await createAgentSession({ modelRuntime: f.runtime, model: f.registry.find('window-test', 'child'),
    resourceLoader: loader, settingsManager, tools: [] });
  const errors: string[] = [];
  session.extensionRunner.setFlagValue('optchat-profile', name);
  const ui = { ...session.extensionRunner.getUIContext(), select,
    notify: (text: string, type?: string) => { if (type === 'error') errors.push(text); } };
  await session.bindExtensions({ uiContext: ui, mode: 'tui', onError: error => errors.push(error.error) });
  return { session, errors, async close() { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } };
}

test('the busy-profile menu offers background subagents below Connect and selecting one opens that same session', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-menu-home-'));
  createProfile('menu');
  const unlock = await lockProfile(profilePath('menu'), 'Main window');
  const close = await serveWindows(profilePath('menu'), f.children, () => true, async () => {});
  const [available] = await f.children.spawn([{ task: 'hold work available' }], f.dir);
  let choices: string[] = [];
  const client = await menuClient(f, 'menu', async (title, options) => {
    assert.match(title, /menu is open in another window/); choices = options;
    return options.find(option => option.startsWith(`Open subagent ${available}`));
  });
  try {
    assert.deepEqual(client.errors, []);
    assert.equal(choices[0], 'Start a connected subagent conversation here');
    assert.match(choices[1], new RegExp(`^Open subagent ${available}.*hold work available`));
    assert.equal(choices.at(-1), 'Back');
    assert.equal(client.session.sessionManager.getEntries().some(e => e.type === 'custom' && e.customType === 'optchat.profile'), false);
    await client.session.prompt('Guidance via the menu-selected existing agent.');
    assert.equal(f.children.history.records.get(available)?.guidance.at(-1)?.text, 'Guidance via the menu-selected existing agent.');
    assert.equal(f.children.history.records.size, 1);
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.children.history.records.get(available)?.state, 'running');
  } finally {
    await client.close(); await close(); await unlock(); await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

/** A real local socket with a deliberately old or unresponsive owner, never a provider/API call. */
async function unresponsiveOwner(directory: string, dropRequests = false) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (dropRequests) socket.on('data', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(profileSocket(directory, 'windows'), resolve); });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
}

test('listing an unresponsive owner times out quickly and closes the listing socket', async () => {
  const f = await fixture();
  const close = await unresponsiveOwner(f.dir);
  try {
    const start = Date.now();
    await assert.rejects(listAttachableAgents(f.dir, 100), /timed out/);
    assert.ok(Date.now() - start < 2000, 'listing must not inherit the 120-second conversation timeout');
  } finally { await close(); await f.close(); }
});

test('the busy-profile menu falls back to Connect/Back after a silent owner, within the two-second listing budget', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-menu-silent-'));
  createProfile('silent');
  const unlock = await lockProfile(profilePath('silent'), 'Silent main window');
  const close = await unresponsiveOwner(profilePath('silent'));
  let menuTime = 0, options: string[] = [];
  const start = Date.now();
  const client = await menuClient(f, 'silent', async (_title, choices) => { menuTime = Date.now(); options = choices; return undefined; });
  try {
    assert.deepEqual(options, ['Start a connected subagent conversation here', 'Back']);
    assert.ok(menuTime - start < 5000, 'startup must not wait 120 seconds for a listing');
    assert.equal(f.children.history.records.size, 0);
  } finally {
    await client.close(); await close(); await unlock(); await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('attachment to an older owner that drops unknown requests gives an update/restart instruction', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-old-owner-'));
  createProfile('old');
  const close = await unresponsiveOwner(profilePath('old'), true);
  const pi = { sendMessage() {} } as unknown as ExtensionAPI;
  const ctx = { cwd: f.dir, ui: { setStatus() {}, setWidget() {}, notify() {}, setTitle() {} } } as unknown as ExtensionContext;
  try {
    await assert.rejects(openConnectedWindow(pi, ctx, 'old', undefined, 'existing-id'), /OptChat version.*Update OptChat and restart/);
    assert.equal(f.children.history.records.size, 0);
  } finally {
    await close(); await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('a menu agent that finishes before selection is rejected and the menu refreshes without opening history', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-menu-finished-'));
  createProfile('menu');
  const unlock = await lockProfile(profilePath('menu'), 'Main window');
  const close = await serveWindows(profilePath('menu'), f.children, () => true, async () => {});
  const [id] = await f.children.spawn([{ task: 'hold work finish during menu' }], f.dir);
  let menus = 0;
  const client = await menuClient(f, 'menu', async (_title, options) => {
    if (++menus === 1) {
      const selected = options.find(o => o.startsWith(`Open subagent ${id}`)); assert.ok(selected);
      await f.children.interrupt(id); await f.children.tell(id, 'Finish before selection.');
      await until(() => !f.children.live(id));
      return selected;
    }
    assert.ok(!options.some(o => o.includes(id)));
    return undefined;
  });
  try {
    assert.equal(menus, 2);
    assert.ok(client.errors.some(e => /no longer available in the menu/.test(e)));
    assert.equal(f.children.history.records.size, 1);
    assert.equal(client.session.sessionManager.getEntries().some(e => e.type === 'custom' && e.customType === 'optchat.profile'), false);
  } finally {
    await client.close(); await close(); await unlock(); await f.close();
    removeDir(process.env.OPTCHAT_HOME!);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test("Pi's compaction replaces session.messages, yet a connected window still gets every later reply", async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async () => {});
  const client = await connectWindow(f.dir, e => events.push(e), () => {});
  const replies = () => events.filter(e => e.name === 'message' && e.from === 'agent').map(e => e.text);
  try {
    await client.request('start', 'long reply', f.dir);
    const id = events.find(e => e.name === 'started')!.text;
    for (const [n, text] of [[2, 'long reply'], [3, 'third']] as const) { await until(() => replies().length === n - 1); await client.request('say', text); }
    await until(() => replies().length === 3);
    const session = f.children.live(id)!.session, projection = session.messages;
    await session.compact(); // Pi assigns a new, shorter projection; retries and context edits do too.
    assert.ok(session.messages !== projection && session.messages.length < projection.length);
    await client.request('say', 'after compaction');
    await until(() => replies().length === 4);
    assert.equal(replies().at(-1), 'Reply: after compaction');
  } finally { client.close(); await close(); await f.close(); }
});

/** The window's handoff request must repeat its last request byte for byte, with only its reply and the handoff prompt after it, so the provider reads it all from the cache. */
function assertCachedPrefix(contexts: { messages: string[]; handoff: boolean }[]) {
  const handoff = contexts.findLast(c => c.handoff), before = contexts.slice(0, contexts.lastIndexOf(handoff!)).findLast(c => !c.handoff);
  assert.ok(handoff && before);
  assert.deepEqual(handoff.messages.slice(0, before.messages.length), before.messages);
  assert.equal(handoff.messages.length, before.messages.length + 2);
  assert.match(handoff.messages.at(-2)!, /"role":"assistant"/);
}

test('an ended window writes its own handoff from its cached context, and the compactor is not called', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Investigate this repository.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.finish(id, 'complete');
    const text = f.children.history.records.get(id)?.handoff?.text ?? '';
    assert.match(text, /completed by user\..*\nWindow handoff: kept the existing API\.\n/);
    assert.match(f.contexts.at(-1)!.messages.at(-1)!, /ended: the user completed it/);
    assertCachedPrefix(f.contexts);
    assert.equal(f.summaries.length, 0);
    // The handoff is a turn in the window's own transcript, so its usage is counted with the window's.
    assert.equal(f.ledger.entries.filter(e => e.runId === id).length, f.children.messages(id).filter(m => m.role === 'assistant').length);
    assert.ok(!f.ledger.entries.some(e => e.role === 'compactor'));
    assert.deepEqual(f.warnings, []);
  } finally { await f.close(); }
});

for (const failure of ['error', 'empty'] as const) {
  test(`a window that can't write its handoff (${failure}) falls back to the compactor`, async () => {
    const f = await fixture();
    f.control.window = failure;
    try {
      const [id] = await f.children.spawn([{ task: 'Investigate this repository.' }], f.dir, undefined, undefined, true);
      await until(() => f.children.history.records.get(id)?.state === 'waiting');
      await f.children.finish(id, 'complete');
      assert.ok(f.contexts.some(c => c.handoff));
      assert.equal(f.summaries.length, 1);
      assert.match(f.children.history.records.get(id)?.handoff?.text ?? '', /Handoff: retained the user correction/);
      assert.match(f.warnings.join('\n'), new RegExp(`${id} could not write its own handoff, so the compactor writes it`));
    } finally { await f.close(); }
  });
}

test('a window may check a fact with a tool before its handoff, and only its final reply is the handoff', async () => {
  const f = await fixture();
  f.control.window = 'tool call, then handoff';
  try {
    const [id] = await f.children.spawn([{ task: 'Investigate this repository.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.finish(id, 'complete');
    const text = f.children.history.records.get(id)?.handoff?.text ?? '';
    assert.match(text, /Window handoff: kept the existing API/);
    assert.doesNotMatch(text, /Let me check/);
    assert.match(f.contexts.at(-1)!.messages.at(-1)!, /"role":"toolResult".*CHECKED_BEFORE_HANDOFF/);
    assert.equal(f.summaries.length, 0);
  } finally { await f.close(); }
});

test('a window whose subagent was stopped by its ending still writes its handoff, told which subagents were stopped', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'hold work parent' }], f.dir, undefined, undefined, true);
    await until(() => f.requests.some(text => text.includes('hold work parent')));
    const [child] = await f.children.spawn([{ task: 'hold work descendant' }], f.dir, undefined, id);
    await until(() => f.requests.some(text => text.includes('hold work descendant')));
    await f.children.finish(id, 'complete');
    assert.equal(f.children.history.records.get(child)?.state, 'stopped');
    assert.ok(f.contexts.at(-1)!.messages.at(-1)!.includes(`Stopped subagents: \`${child}\` (full transcripts available via zoom)`));
    assert.equal(f.summaries.length, 0);
    assert.match(f.children.history.records.get(id)?.handoff?.text ?? '', /Window handoff: kept the existing API/);
  } finally { await f.close(); }
});

test('a report a paused window never read goes into its handoff request', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'hold work parent' }], f.dir, undefined, undefined, true);
    await until(() => f.requests.some(text => text.includes('hold work parent')));
    const [child] = await f.children.spawn([{ task: 'slow descendant' }], f.dir, undefined, id);
    assert.equal(await f.children.interrupt(id), 'paused');
    await until(() => f.children.history.records.get(child)?.state === 'completed');
    await f.children.finish(id, 'complete');
    assert.match(f.contexts.at(-1)!.messages.at(-1)!, new RegExp(`Reports from your subagents that you never read:.*\\[${child}\\]`));
    assert.equal(f.summaries.length, 0);
  } finally { await f.close(); }
});

test('guidance still queued in Pi when a busy window completes is listed in its handoff request, not taken as new input', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'hold work parent' }], f.dir, undefined, undefined, true);
    await until(() => f.requests.some(text => text.includes('hold work parent')));
    await f.children.tell(id, 'STALE_GUIDANCE', 'user');
    await f.children.finish(id, 'complete');
    const handoffs = f.contexts.filter(c => c.handoff);
    assert.equal(handoffs.length, 1, 'one handoff request, with no turn after it');
    assert.match(handoffs[0].messages.at(-1)!, /never got:.*STALE_GUIDANCE/);
    assert.ok(!handoffs[0].messages.slice(0, -1).some(m => m.includes('STALE_GUIDANCE')));
    assert.match(f.children.history.records.get(id)?.handoff?.text ?? '', /Window handoff: kept the existing API/);
  } finally { await f.close(); }
});

test('closing while a window writes its handoff does not wait for it, and the next start writes it', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Investigate this repository.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    f.control.holdSummary = true;
    const finishing = f.children.finish(id, 'complete');
    await until(() => f.contexts.some(c => c.handoff));
    f.children.deferHandoffs(); await f.children.close(); await finishing;
    assert.deepEqual(f.children.history.records.get(id)?.handoff, { reason: 'complete' });
    f.control.holdSummary = false;
    const delivered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { delivered.push(text); }, () => {}, f.dir, f.options);
    try {
      await restored.recoverHandoffs();
      assert.equal(delivered.length, 1);
      assert.match(delivered[0], /completed by user\..*\nWindow handoff: kept the existing API\.\n/);
      assert.equal(f.summaries.length, 0);
    } finally { await restored.close(); }
  } finally { await f.close(); }
});

test('a handoff tool that ignores the abort holds up neither closing nor the timeout fallback', async () => {
  for (const ending of ['close', 'timeout'] as const) {
    const f = await fixture();
    f.control.window = 'stuck tool';
    if (ending === 'timeout') f.options.windowHandoffTimeout = 100;
    try {
      const [id] = await f.children.spawn([{ task: 'Investigate this repository.' }], f.dir, undefined, undefined, true);
      await until(() => f.children.history.records.get(id)?.state === 'waiting');
      const finishing = f.children.finish(id, 'complete');
      await until(() => f.contexts.some(c => c.handoff));
      if (ending === 'close') {
        f.children.deferHandoffs(); await f.children.close(); await finishing;
        assert.deepEqual(f.children.history.records.get(id)?.handoff, { reason: 'complete' }, 'left for the next start');
      } else {
        await finishing;
        assert.match(f.warnings.join('\n'), /could not write its own handoff, so the compactor writes it/);
        assert.match(f.children.history.records.get(id)?.handoff?.text ?? '', /Handoff: retained the user correction/);
      }
    } finally { f.control.releaseTool(); await f.close(); }
  }
});

test('a batch flushed by a stopped child still hands its finished sibling\'s report to the stopping window', async () => {
  const f = await fixture();
  f.options.settings = () => ({ ...nested(), groupReports: true });
  try {
    const [id] = await f.children.spawn([{ task: 'hold work parent' }], f.dir, undefined, undefined, true);
    await until(() => f.requests.some(text => text.includes('hold work parent')));
    const [done, held] = await f.children.spawn([{ task: 'Investigate this repository.' }, { task: 'hold work descendant' }], f.dir, undefined, id);
    await until(() => f.children.history.records.get(done)?.state === 'completed');
    await f.children.finish(id, 'complete');
    assert.equal(f.children.history.records.get(held)?.state, 'stopped');
    const request = f.contexts.findLast(c => c.handoff)!.messages.at(-1)!;
    assert.match(request, new RegExp(`never read:.*\\[${done}\\]`));
    assert.match(request, new RegExp(`Stopped subagents: \`${held}\``));
    assert.ok(!request.includes(`[${held}]`), 'the stopped child is named, not reported');
  } finally { await f.close(); }
});

test('a handoff deferred by /reload is written by the reopened window on the next start', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Investigate this repository.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    f.children.deferHandoffs(); await f.children.close();
    assert.deepEqual(f.children.history.records.get(id)?.handoff, { reason: 'owner-stopped' });
    assert.ok(!f.contexts.some(c => c.handoff), 'closing does not ask the window');
    const delivered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { delivered.push(text); }, () => {}, f.dir, f.options);
    try {
      await restored.recoverHandoffs();
      assert.equal(delivered.length, 1);
      assert.match(delivered[0], /interrupted \(owner-stopped\)\..*\nWindow handoff: kept the existing API\.\n/);
      assert.match(f.contexts.at(-1)!.messages.at(-1)!, /ended: the main Pi window closed or reloaded/);
      assertCachedPrefix(f.contexts);
      assert.equal(f.summaries.length, 0);
    } finally { await restored.close(); }
  } finally { await f.close(); }
});
