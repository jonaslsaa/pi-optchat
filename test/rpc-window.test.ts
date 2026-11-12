import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, lockProfile, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { ROLE_STATUS, type Role } from '../src/rpc-window.ts';
import { fixtureProvider, type Sent } from './fixtures/rpc-provider.ts';
import { removeDir } from './support.ts';

// Short paths: the profile's sockets have a ~103-byte limit on macOS.
const root = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'oc-rpcw-') : '/tmp/oc-rpcw-');
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});
let profiles = 0;
const profile = () => {
  const name = `p${profiles++}`;
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  return name;
};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
/** Memory as the files have it, so a test can tell who wrote what. */
const logged = (name: string) => readdirSync(join(profilePath(name), 'main')).flatMap(file => readFileSync(join(profilePath(name), 'main', file), 'utf8').split('\n').filter(Boolean))
  .map(line => { const entry: unknown = JSON.parse(line); return entry && typeof entry === 'object' && 'text' in entry ? String(entry.text) : ''; });

/** An RPC session on `profile`, as a host like T3 Code starts one per thread. */
async function rpc(name: string, connect?: string, mode: 'rpc' | 'json' = 'rpc', flag = mode === 'rpc') {
  const dir = mkdtempSync(join(root, 's-'));
  const sent: Sent[] = [], notes: string[] = [], errors: string[] = [], roles: Role[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', fixtureProvider(sent));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager });
  if (flag) session.extensionRunner.setFlagValue('optchat-profile', name);
  if (connect) session.extensionRunner.setFlagValue('optchat-connect', connect);
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: message => { notes.push(message); },
    setStatus: (key, text) => { if (key === ROLE_STATUS && text) roles.push(JSON.parse(text) as Role); },
    select: async () => { throw new Error('an RPC session must not ask'); } };
  // As Pi's RPC mode binds them: /complete waits for the handoff turn with waitForIdle.
  const cancelled = async () => ({ cancelled: true });
  await session.bindExtensions({ uiContext, mode, onError: error => { errors.push(error.error); },
    commandContextActions: { waitForIdle: () => session.waitForIdle(), newSession: cancelled, fork: cancelled, navigateTree: cancelled, switchSession: cancelled, reload: async () => {} } });
  const ask = async (text: string) => {
    const before = session.state.messages.length;
    await session.prompt(text);
    const reply = session.state.messages.slice(before).findLast(m => m.role === 'assistant');
    return reply?.role === 'assistant' ? textContent(reply.content) : undefined;
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { ask, close, sent, notes, errors, roles, session, role: () => roles.at(-1) };
}

/** The window's `after` is where its conversation starts: a host that shows messages from it shows what the agent read, then its reply. */
function assertBoundary(window: Awaited<ReturnType<typeof rpc>>) {
  const role = window.role(), marker = window.session.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'optchat-window-completed');
  assert.ok(role?.role === 'window' && marker && role.after === Date.parse(marker.timestamp), 'the boundary is the completion marker');
  const shown = window.session.messages.filter(m => m.timestamp >= role.after!);
  assert.deepEqual(shown.map(m => m.role), ['user', 'assistant'], 'from it on: the request the agent read, and its reply');
}

test('an RPC session on a busy profile joins as a connected window: its own agent answers with the view, memory stays the owner\'s, and /complete hands off', async () => {
  const name = profile(), owner = await rpc(name);
  const window = await rpc(name);
  try {
    assert.deepEqual(owner.role(), { role: 'owner', profile: name });
    await owner.ask('The colour is teal.');
    const id = window.role()?.role === 'window' ? window.role() : undefined;
    assert.deepEqual({ ...id, id: undefined }, { role: 'window', profile: name, id: undefined, connected: true, completed: false });
    assert.deepEqual(window.errors, []);
    // Opening a window sends the main agent nothing: only its first message does, as in a terminal window.
    const calls = owner.sent.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(owner.sent.length, calls, 'a window that never prompts costs the main agent no turn');
    assert.ok(!existsSync(join(profilePath(name), 'runs')) || readdirSync(join(profilePath(name), 'runs')).length === 0, 'and is no run yet');

    assert.equal(await window.ask('What colour?'), 'Reply: What colour?', 'the window\'s own Pi answers');
    const [request] = window.sent;
    assert.match(request.system, /You are a connected window of OptChat/);
    assert.match(request.messages.join('\n'), /The colour is teal\./, 'the view, read from disk, comes with the request');
    assert.ok(!window.sent.some(s => s.system.includes('"spawn"')) && !window.session.getActiveToolNames().includes('spawn'), 'a window delegates nothing');
    assert.ok(window.session.getActiveToolNames().includes('zoom'));
    // The owner's agent is told about the window (a turn that changes the view), and summarizes that long report.
    await until(() => owner.sent.some(s => s.last.includes('User started a connected conversation')) && !owner.session.isStreaming);
    await new Promise(resolve => setTimeout(resolve, 300));
    await window.ask('And the size?');
    const moved = window.sent[1].messages, at = moved.findIndex(m => m.includes('<chat>'));
    assert.ok(at > 0 && moved[at].includes('And the size?'), 'a changed view moves to the newest request');
    assert.match(moved[at], /User started a connected conversation/);
    await window.ask('And the shape?');
    assert.equal(window.sent[2].messages.findIndex(m => m.includes('<chat>')), at, 'an unchanged view stays where it was, so the rest is read from the cache');
    assert.equal(window.sent[2].messages[at], moved[at]);
    assert.ok(!logged(name).some(text => text.includes('What colour?') && !text.includes('User started')), 'the window\'s conversation is not in memory');

    await window.ask('/complete');
    const record = readdirSync(join(profilePath(name), 'runs')).filter(f => f.endsWith('.optchat.json'))
      .map(f => JSON.parse(readFileSync(join(profilePath(name), 'runs', f), 'utf8')) as { id: string; state: string; sessionFile?: string; handoff?: { delivered?: boolean } });
    assert.equal(record.length, 1);
    const role = window.role();
    assert.equal(role?.role === 'window' && role.id, record[0].id);
    await until(() => owner.sent.some(s => s.last.includes('completed by user')));
    const report = owner.sent.find(s => s.last.includes('completed by user'))!.last;
    assert.match(report, /Handoff: the user asked about the colour/, 'the window wrote the handoff itself');
    const asked = window.session.sessionManager.getEntries().filter(e => e.type === 'custom_message' && e.customType === 'optchat-handoff-request');
    assert.equal(asked.length, 1, 'the handoff request is OptChat\'s own message, not a user message');
    assert.ok(asked.every(e => e.type === 'custom_message' && !e.display), 'hosts don\'t show it as the user\'s');
    assert.equal(record[0].state, 'completed');
    assert.ok(record[0].sessionFile && existsSync(record[0].sessionFile), 'the owner keeps a copy of the window\'s transcript');
    const done = window.role();
    assert.equal(done?.role === 'window' && done.completed, true);
    assert.ok(!window.roles.some(r => r.role === 'window' && r.after !== undefined), 'no boundary before one is set');

    // A host that keeps prompting gets a new connected conversation in the same session, not a hang.
    assert.equal(await window.ask('Next topic?'), 'Reply: Next topic?');
    const next = window.role();
    assert.ok(next?.role === 'window' && next.id !== record[0].id && !next.completed, 'a new window, announced to the host');
    assert.equal(window.sent.at(-1)!.messages.length, 1, 'only its own request: the completed conversation is not in its context');
    assert.match(window.sent.at(-1)!.system, /You are a connected window of OptChat/, 'with its system prompt still in front');
    assert.match(window.sent.at(-1)!.messages[0], /<chat>/, 'and the view on its request');
    assert.deepEqual(window.errors, []);
    assertBoundary(window);
    await until(() => owner.sent.some(s => s.last.includes(`[${next.id}] User started a connected conversation`)));
    // Closed without /complete: the compactor gets this conversation's transcript only, not the completed one before it.
    await window.close();
    await until(() => owner.sent.some(s => s.last.includes(`[${next.id}] Connected conversation interrupted`)));
    const summarized = owner.sent.find(s => s.system.includes('handoff') && s.last.includes('Next topic?'))?.last ?? '';
    assert.ok(summarized && !summarized.includes('What colour?'), 'only its own conversation is summarized');
  } finally { await window.close(); await owner.close(); }
});

test('a window that completes and then closes is handed off once', async () => {
  const name = profile(), owner = await rpc(name), window = await rpc(name);
  try {
    await window.ask('Ship it.');
    const role = window.role(), id = role?.role === 'window' ? role.id : '';
    await window.ask('/complete');
    await window.close();
    // The owner's fixture model echoes what it gets, so its reply quotes the report too.
    const reports = () => logged(name).filter(text => text.includes(`[${id}] Connected conversation`) && !text.startsWith('Reply:')).length;
    await until(() => reports() > 0 && !owner.session.isStreaming);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(reports(), 1, 'its socket dropping after the handoff ends nothing more');
  } finally { await owner.close(); }
});

test('a completed window\'s session resumed in a new process starts a new conversation without the completed one', async () => {
  const name = profile(), owner = await rpc(name), window = await rpc(name);
  try {
    await window.ask('First topic.');
    await window.ask('/complete');
    // The host released the process and resumes the thread later: Pi closes the session, then starts it again from its file.
    await window.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await window.session.extensionRunner.emit({ type: 'session_start', reason: 'resume' });
    const role = window.role();
    assert.ok(role?.role === 'window' && !role.completed);
    assert.equal(await window.ask('Second topic.'), 'Reply: Second topic.');
    assert.equal(window.sent.at(-1)!.messages.length, 1, 'the completed conversation stays out of its context');
    assert.match(window.sent.at(-1)!.system, /You are a connected window of OptChat/, 'with its system prompt still in front');
    assert.deepEqual(window.errors, []);
    assertBoundary(window);
    // Back on a branch from before /complete (Pi's tree navigation), that conversation is this window's again.
    const first = window.session.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'assistant');
    window.session.sessionManager.branch(first!.id);
    await window.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await window.session.extensionRunner.emit({ type: 'session_start', reason: 'resume' });
    await window.ask('Back again.');
    assert.equal(window.sent.at(-1)!.messages.length, 3, 'its request, the reply, then the new one');
  } finally { await window.close(); await owner.close(); }
});

test('Pi\'s own compaction in a window keeps its conversation going with the view on the newest request', async () => {
  const name = profile(), owner = await rpc(name), window = await rpc(name);
  try {
    await owner.ask('The colour is teal.');
    await window.ask('One.'); await window.ask('Two.'); await window.ask('Three.');
    await window.session.compact();
    assert.equal(await window.ask('Four?'), 'Reply: Four?');
    const request = window.sent.at(-1)!.messages, at = request.findIndex(m => m.includes('<chat>'));
    assert.ok(request.length < 7, 'compacted');
    assert.ok(at >= 0 && request[at].includes('Four?') && request[at].includes('The colour is teal.'), 'the view, on the newest request');
  } finally { await window.close(); await owner.close(); }
});

test('a window keeps its conversation when Pi binds the same session again, and its record survives an owner restart', async () => {
  const name = profile();
  let owner = await rpc(name);
  const window = await rpc(name);
  try {
    await window.ask('Keep going.');
    const role = window.role(), id = role?.role === 'window' ? role.id : '';
    // RPC binds extensions twice after new_session (#258).
    await window.session.extensionRunner.emit({ type: 'session_start', reason: 'new' });
    const again = window.role();
    assert.equal(again?.role === 'window' && again.id, id, 'the same window');
    await owner.close();
    owner = await rpc(name);
    await new Promise(resolve => setTimeout(resolve, 300));
    const saved = JSON.parse(readFileSync(join(profilePath(name), 'runs', `${id}.optchat.json`), 'utf8')) as { state: string; handoff?: unknown };
    assert.equal(saved.state, 'running', 'its process is alive, so a restart does not end it');
    assert.equal(saved.handoff, undefined);
    assert.ok(!owner.sent.some(s => s.last.includes(`[${id}] Connected conversation`)), 'nor hands it off');
  } finally { await window.close(); await owner.close(); }
});

test('with no owner to reach, a window still answers from memory on disk and its handoff waits for the next owner', async () => {
  const name = profile(), seed = await rpc(name);
  await seed.ask('The password hint is lighthouse.'); await seed.close();
  // A headless run holding the profile serves no windows.
  const unlock = await lockProfile(profilePath(name), `${name} · PID 1 · elsewhere`);
  const window = await rpc(name);
  try {
    assert.deepEqual({ ...window.role(), id: undefined }, { role: 'window', profile: name, id: undefined, connected: false, completed: false });
    assert.equal(await window.ask('What is the hint?'), 'Reply: What is the hint?');
    assert.match(window.sent[0].messages.join('\n'), /lighthouse/);
    await window.ask('/complete');
    assert.match(window.notes.at(-1) ?? '', /waits in the profile/);
  } finally { await window.close(); await unlock(); }
  const owner = await rpc(name);
  try {
    await until(() => owner.sent.some(s => s.last.includes('completed by user')));
    assert.match(owner.sent.find(s => s.last.includes('completed by user'))!.last, /Handoff: the user asked about the colour/);
    assert.deepEqual(readdirSync(join(profilePath(name), 'remote-windows')), [], 'the queue is drained');
  } finally { await owner.close(); }
});

test('--optchat-connect join needs a running owner, and off refuses a busy profile as before', async () => {
  const name = profile();
  const alone = await rpc(name, 'join');
  try { assert.match(alone.errors[0] ?? '', /No running OptChat session/); } finally { await alone.close(); }
  const owner = await rpc(name), refused = await rpc(name, 'off');
  try {
    assert.match(refused.errors[0] ?? '', /Profile already running/);
    assert.equal(await refused.ask('Hello'), undefined);
  } finally { await refused.close(); await owner.close(); }
});

test('JSON mode never joins a busy profile, by flag or by /optchat profile: its output is Pi\'s own events', async () => {
  const name = profile(), owner = await rpc(name), json = await rpc(name, undefined, 'json');
  try {
    await json.ask(`/optchat profile ${name}`);
    assert.match(json.notes.join('\n'), /already running/);
    assert.equal(await json.ask('Hello'), undefined, 'a profile that failed to open blocks prompts');
    assert.equal(owner.sent.length, 0);
  } finally { await json.close(); await owner.close(); }
});

test('/optchat profile in a new RPC session follows --optchat-connect as the flag does: join never opens an idle profile', async () => {
  const name = profile(), joining = await rpc(name, 'join', 'rpc', false);
  try {
    assert.match(joining.errors[0] ?? '', /join needs a profile/);
    process.exitCode = undefined; // As Pi would exit with that error; this test goes on.
    await joining.ask(`/optchat profile ${name}`);
    assert.match(joining.notes.join('\n'), /No running OptChat session/);
    assert.equal(joining.role()?.role, undefined, 'neither owner nor window');
  } finally { await joining.close(); }
});

test('a window registered with an owner that closed queues its /complete, and the next owner delivers that, even after its process is gone', async () => {
  const name = profile();
  let owner = await rpc(name);
  const window = await rpc(name);
  await window.ask('Track the release.');
  await owner.close();
  await window.ask('/complete');
  await window.close();
  // As if the window's process had exited before the next owner opened: its record and its queue entry name a dead process.
  const dead = 2 ** 22 + 12345, dir = profilePath(name), id = readdirSync(join(dir, 'remote-windows'))[0].replace(/\.json$/, '');
  for (const file of [join(dir, 'remote-windows', `${id}.json`), join(dir, 'runs', `${id}.optchat.json`)]) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; window?: { pid: number } };
    if (saved.window) saved.window.pid = dead; else saved.pid = dead;
    writeFileSync(file, JSON.stringify(saved));
  }
  owner = await rpc(name);
  try {
    await until(() => owner.sent.some(s => s.last.includes(`[${id}] Connected conversation`)));
    const report = owner.sent.find(s => s.last.includes(`[${id}] Connected conversation`))!.last;
    assert.match(report, /completed by user/, 'the window\'s own ending, not the restart\'s');
    assert.match(report, /Handoff: the user asked about the colour/);
  } finally { await owner.close(); }
});

test('an idle window registers with an owner that opens later, which then hands it off when it closes', async () => {
  const name = profile(), unlock = await lockProfile(profilePath(name), `${name} · PID 1 · elsewhere`);
  const window = await rpc(name);
  await window.ask('Watch the queue.');
  await unlock();
  const owner = await rpc(name);
  try {
    await until(() => { const role = window.role(); return role?.role === 'window' && role.connected; });
    await until(() => owner.sent.some(s => s.last.includes('User started a connected conversation')));
    // Registered, it leaves the queue.
    await until(() => readdirSync(join(profilePath(name), 'remote-windows')).length === 0);
    await window.close();
    await until(() => owner.sent.some(s => s.last.includes('interrupted (disconnected)')));
  } finally { await owner.close(); }
});

test('a window on a missing profile is refused, and nothing is created', async () => {
  const missing = await rpc('nope', 'join');
  try {
    assert.match(missing.errors[0] ?? '', /does not exist/);
    assert.equal(existsSync(profilePath('nope')), false);
  } finally { await missing.close(); }
});
