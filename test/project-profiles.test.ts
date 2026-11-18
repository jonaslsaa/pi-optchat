import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type CreateAgentSessionRuntimeFactory, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, lastProfile, loadConfig, profilePath, profileOwner, saveConfig } from '../src/profiles.ts';
import { createProjectProfile, discoverProjectProfile, resolveProfile } from '../src/project-profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'oc-project-'));
const oldHome = process.env.OPTCHAT_HOME;
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => { if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome; removeDir(root); });
const sandbox = () => mkdtempSync(join(root, 's-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const repository = () => { const dir = sandbox(); git(dir, 'init', '-q', '-b', 'main'); return dir; };
const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
function project(cwd: string) {
  const ref = createProjectProfile(cwd);
  saveConfig(ref.dir, { ...loadConfig(ref.dir), compactor: fixture, subagent: fixture });
  return ref;
}
function global(name: string) {
  createProfile(name); const dir = profilePath(name);
  saveConfig(dir, { ...loadConfig(dir), compactor: fixture, subagent: fixture });
}
async function start(dir: string, options: { mode?: 'tui' | 'rpc' | 'print'; bound?: unknown; flag?: string; connect?: string; agent?: string; ui?: Partial<ExtensionUIContext>; manager?: SessionManager; lifecycle?: boolean } = {}) {
  const state = sandbox(), sent: Context[] = [], notes: string[] = [], errors: string[] = [], picks: string[][] = [], statuses: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(state, 'auth.json'), modelsPath: null, modelsStorePath: join(state, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      sent.push(structuredClone(context));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'fixture reply' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(state, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = options.manager ?? SessionManager.create(dir, join(state, 'sessions'));
  if (options.bound !== undefined) manager.appendCustomEntry('optchat.profile', options.bound);
  const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] });
  if (options.flag !== undefined) session.extensionRunner.setFlagValue('optchat-profile', options.flag);
  if (options.connect !== undefined) session.extensionRunner.setFlagValue('optchat-connect', options.connect);
  if (options.agent !== undefined) session.extensionRunner.setFlagValue('optchat-agent', options.agent);
  let host: AgentSessionRuntime | undefined;
  if (options.lifecycle) {
    const make: CreateAgentSessionRuntimeFactory = async target => {
      const resources = new DefaultResourceLoader({ cwd: target.cwd, agentDir: target.agentDir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
      await resources.reload();
      const created = await createAgentSession({ ...target, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: resources, settingsManager, tools: ['zoom', 'date'] });
      return { ...created, services: { cwd: target.cwd, agentDir: target.agentDir, modelRuntime: runtime, resourceLoader: resources, settingsManager, diagnostics: [] }, diagnostics: [] };
    };
    host = new AgentSessionRuntime(session, { cwd: dir, agentDir: join(state, 'agent'), modelRuntime: runtime, resourceLoader: loader, settingsManager, diagnostics: [] }, make);
  }
  const bind = async (current: AgentSession) => current.bindExtensions({ mode: options.mode ?? 'rpc', onError: error => { errors.push(error.error); },
    uiContext: { ...current.extensionRunner.getUIContext(), notify: note => { notes.push(note); }, setStatus: (_key, text) => { if (text) statuses.push(text); }, select: async (_title, choices) => { picks.push(choices); return undefined; }, ...options.ui },
    ...host && { commandContextActions: { waitForIdle: () => current.agent.waitForIdle(), newSession: host.newSession.bind(host), fork: host.fork.bind(host),
      switchSession: host.switchSession.bind(host), navigateTree: () => { throw new Error('Unused fixture action'); }, reload: () => { throw new Error('Unused fixture action'); } } } });
  host?.setRebindSession(bind);
  await bind(session);
  const current = () => host?.session ?? session;
  return { get session() { return current(); }, sent, notes, errors, picks, statuses, get manager() { return current().sessionManager; }, host,
    bindings: () => current().sessionManager.getEntries().flatMap(e => e.type === 'custom' && e.customType === 'optchat.profile' ? [e.data] : []),
    close: async () => { if (host) await host.dispose(); else { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } process.exitCode = undefined; } };
}



for (const alias of [false, true]) test(`discovery is read-only; explicit creation is shared by subdirectories and leaves the source tree untouched (directory alias ${alias})`, () => {
  const physical = repository(), dir = alias ? join(sandbox(), 'alias') : physical;
  if (alias) symlinkSync(physical, dir, process.platform === 'win32' ? 'junction' : 'dir');
  const child = join(dir, 'src'); mkdirSync(child);
  assert.equal(discoverProjectProfile(child), undefined);
  assert.ok(!existsSync(join(dir, '.pi')));
  const ref = project(child);
  // Git may expand Windows 8.3 names (RUNNER~1) or directory aliases; compare the actual locations.
  assert.equal(realpathSync.native(ref.dir), realpathSync.native(join(dir, '.pi', 'optchat')));
  assert.deepEqual(discoverProjectProfile(dir), ref);
  assert.deepEqual(discoverProjectProfile(child), ref);
  assert.deepEqual(discoverProjectProfile(physical), ref, 'directory aliases select the same project profile');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(dir, '.gitignore')), 'the source project needs no tracked ignore edit');
  assert.ok(!existsSync(join(ref.dir, 'profiles')));
  const before = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.deepEqual(createProjectProfile(child), ref);
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), before);
});

test('linked worktrees and nested repositories have independent project memories', () => {
  const dir = repository(); writeFileSync(join(dir, 'app'), 'source'); git(dir, 'add', 'app');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial');
  const linked = join(sandbox(), 'linked'); git(dir, 'worktree', 'add', '-q', '-b', 'linked', linked);
  const original = project(dir), other = project(linked);
  assert.notEqual(original.dir, other.dir);
  assert.deepEqual(discoverProjectProfile(linked), other);
  const nested = join(dir, 'nested'); mkdirSync(nested); git(nested, 'init', '-q');
  assert.equal(discoverProjectProfile(nested), undefined, 'the outer project never leaks into an inner repository');
});

test('tracked profiles and conflicting ignore rules refuse creation before memory is written', () => {
  const dir = repository(); writeFileSync(join(dir, '.gitignore'), '!/.pi/optchat/\n');
  assert.throws(() => project(dir), /ignore rules expose/);
  assert.ok(!existsSync(join(dir, '.pi', 'optchat')));
  mkdirSync(join(dir, '.pi', 'optchat'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'optchat', 'keep'), 'tracked');
  git(dir, 'add', '-f', '.pi/optchat/keep');
  assert.throws(() => createProjectProfile(dir), /tracked by Git/);
  assert.equal(readFileSync(join(dir, '.pi', 'optchat', 'keep'), 'utf8'), 'tracked');
});

test('project discovery refuses symlinked storage', { skip: process.platform === 'win32' }, () => {
  for (const leaf of [false, true]) {
    const dir = repository(), outside = sandbox();
    if (leaf) mkdirSync(join(dir, '.pi'));
    symlinkSync(outside, join(dir, '.pi', ...leaf ? ['optchat'] : []), 'dir');
    assert.throws(() => discoverProjectProfile(dir), /real directory/);
    assert.throws(() => createProjectProfile(dir), /real directory/);
    assert.deepEqual(readdirSync(outside), []);
  }
});

test('an existing project autoloads without a picker in TUI, print and RPC, independently of OPTCHAT_HOME', async () => {
  const dir = repository(), child = join(dir, 'src'); mkdirSync(child);
  const ref = project(dir), home = process.env.OPTCHAT_HOME;
  writeFileSync(join(ref.dir, 'AGENTS.md'), 'PROJECT-INSTRUCTIONS');
  for (const mode of ['tui', 'print', 'rpc'] as const) {
    const pi = await start(child, { mode });
    try {
      assert.deepEqual(pi.errors, []); assert.deepEqual(pi.picks, []);
      assert.deepEqual(pi.bindings(), [ref]);
      assert.ok(pi.statuses.some(s => s.startsWith(`OptChat: ${resolveProfile(ref).name} ·`)));
      await pi.session.prompt(`remember ${mode}`);
      assert.match(JSON.stringify(pi.sent), /PROJECT-INSTRUCTIONS/);
      assert.equal(process.env.OPTCHAT_HOME, home);
    } finally { await pi.close(); }
  }
  assert.ok(!existsSync(join(home!, 'last-profile')), 'opening a project does not change the global last-used profile');
});

test('the picker creates a project and switches between it and a same-named global profile in fresh sessions', async () => {
  const parent = sandbox(), dir = join(parent, 'example'); mkdirSync(dir); git(dir, 'init', '-q'); global('example');
  const pi = await start(dir, { mode: 'tui', lifecycle: true, ui: { select: async (_title, choices) => {
    pi.picks.push(choices); return choices.includes('+ Create project profile') ? '+ Create project profile' : choice;
  } } });
  let choice: string | undefined;
  try {
    assert.deepEqual(pi.bindings(), [{ name: 'example' }]);
    await pi.session.prompt('Global conversation');
    const before = pi.session.sessionManager.getSessionId();
    await pi.session.prompt('/optchat profile');
    const ref = discoverProjectProfile(dir)!;
    assert.ok(ref); assert.deepEqual(pi.bindings(), [ref]);
    assert.notEqual(pi.session.sessionManager.getSessionId(), before);
    assert.equal(pi.session.sessionManager.getEntries().filter(e => e.type === 'message').length, 0, 'global history is not copied');
    saveConfig(ref.dir, { ...loadConfig(ref.dir), compactor: fixture, subagent: fixture });
    choice = 'example'; await pi.session.prompt('/optchat profile');
    assert.deepEqual(pi.bindings(), [{ name: 'example' }]);
    choice = 'example (this project)'; await pi.session.prompt('/optchat profile');
    assert.deepEqual(pi.bindings(), [ref]);
    assert.equal(lastProfile(), 'example');
  } finally { await pi.close(); }
  const fresh = await start(dir, { mode: 'tui' });
  try { assert.deepEqual(fresh.bindings(), [discoverProjectProfile(dir)]); assert.deepEqual(fresh.picks, []); }
  finally { await fresh.close(); }
});

test('saved bindings and the explicit profile flag take precedence; project resumes keep their original directory', async () => {
  const dir = repository(), ref = project(dir); global('override');
  for (const options of [{ flag: 'override' }, { bound: { name: 'override' } }]) {
    const pi = await start(dir, options);
    try { assert.deepEqual(pi.bindings(), [{ name: 'override' }]); assert.deepEqual(pi.errors, []); }
    finally { await pi.close(); }
  }
  const original = await start(dir); let file: string;
  try { await original.session.prompt('Original project memory'); file = original.session.sessionManager.getSessionFile()!; }
  finally { await original.close(); }
  const elsewhere = repository(); project(elsewhere);
  const resumed = await start(elsewhere, { manager: SessionManager.open(file!) });
  try { assert.deepEqual(resumed.bindings(), [ref]); assert.deepEqual(resumed.errors, []); }
  finally { await resumed.close(); }
});

test('busy or invalid project profiles do not open a picker or silently use a global profile', async () => {
  const dir = repository(), ref = project(dir);
  const owner = await start(dir, { mode: 'tui' });
  try {
    for (const bound of [undefined, ref]) {
      const busy = await start(dir, { mode: 'tui', bound, lifecycle: true });
      try {
        assert.deepEqual(busy.picks, []); assert.match(busy.notes.join('\n'), /Profile already running/);
        assert.match(busy.notes.join('\n'), /Use \/optchat profile to connect or choose another profile/);
        await busy.session.prompt('must not answer'); assert.deepEqual(busy.sent, []);
        await busy.host!.newSession();
        assert.deepEqual(busy.picks, [], '/new does not turn autoload into an explicit picker selection');
      } finally { await busy.close(); }
    }
  } finally { await owner.close(); }
  writeFileSync(join(dir, '.pi', 'optchat', 'config.json'), 'invalid');
  const invalid = await start(dir, { mode: 'tui' });
  try {
    assert.deepEqual(invalid.picks, []); assert.ok(invalid.notes.length);
    await invalid.session.prompt('must not answer'); assert.deepEqual(invalid.sent, []);
  } finally { await invalid.close(); }
});

test('explicitly picking a busy project offers the existing connect, back and cancel flows', async () => {
  const dir = repository(), ref = project(dir), name = resolveProfile(ref).name;
  global('busy-fallback');
  const owner = await start(dir, { mode: 'tui' });
  const connect = 'Start a connected subagent conversation here';
  try {
    for (const action of ['Back', undefined, connect]) {
      const asked: { title: string; choices: string[] }[] = [];
      const choices = [`${name} (this project)`, action, ...action === 'Back' ? ['busy-fallback'] : []];
      const pi = await start(dir, { mode: 'tui', lifecycle: true, ui: { select: async (title, options) => {
        asked.push({ title: title.split('\n')[0], choices: options }); return choices.shift();
      } } });
      try {
        assert.equal(asked.length, 0, 'startup does not prompt before the user asks to switch');
        const initialNotes = pi.notes.length;
        await pi.session.prompt('/optchat profile');
        assert.deepEqual(asked.slice(0, 2).map(a => a.title), ['OptChat profile', `${name} is open in another window`]);
        assert.deepEqual(asked[1].choices, [connect, 'Back']);
        assert.deepEqual(pi.errors, []);
        assert.equal(choices.length, 0);
        if (action === 'Back') {
          assert.equal(asked[2].title, 'OptChat profile');
          assert.deepEqual(pi.bindings().at(-1), { name: 'busy-fallback' });
          assert.ok(pi.statuses.some(s => s.startsWith('OptChat: busy-fallback ·')));
        } else {
          assert.deepEqual(pi.bindings().at(-1), ref);
          if (action === connect) {
            assert.ok(pi.statuses.some(s => s.includes('connected window · send a task to start')));
            assert.equal((await pi.session.extensionRunner.emit({ type: 'session_before_switch', reason: 'new' }))?.cancel, true);
            assert.deepEqual(owner.sent, [], 'connecting does not wake the owning agent');
          } else {
            assert.match(pi.notes.slice(initialNotes).join('\n'), /Profile already running/);
            await pi.session.prompt('must not fall back to another memory');
            assert.deepEqual(pi.sent, []);
          }
        }
        if (action !== undefined) assert.ok(!pi.notes.slice(initialNotes).some(n => n.includes('Profile already running')));
      } finally { await pi.close(); }
    }
  } finally { await owner.close(); }
});

test('an RPC window can join an existing project owner using the project directory', async () => {
  const dir = repository(), ref = project(dir), owner = await start(dir, { mode: 'tui' });
  try {
    const window = await start(dir, { mode: 'rpc' });
    try {
      assert.deepEqual(window.errors, []); assert.deepEqual(window.bindings(), [ref]);
      assert.ok(window.statuses.some(s => s.includes('"role":"window"')));
      await window.session.prompt('Connected project conversation');
      assert.ok(window.sent.length > 0);
      assert.deepEqual(owner.sent, [], 'opening the window does not wake the owner');
    } finally { await window.close(); }
  } finally { await owner.close(); }
});


test('project display names with spaces are readable through the existing profile-owner API', async () => {
  const dir = join(sandbox(), 'Large Project'); mkdirSync(dir); git(dir, 'init', '-q');
  const ref = project(dir), pi = await start(dir, { mode: 'tui' });
  try { assert.equal((await profileOwner(ref.dir))?.profile, 'Large Project'); }
  finally { await pi.close(); }
});

test('ordinary directories offer no project action and /new retains a manually selected global profile', async () => {
  const outside = await start(sandbox(), { mode: 'tui' });
  try {
    await outside.session.prompt('/optchat profile');
    assert.ok(outside.picks.every(choices => !choices.some(choice => choice.includes('project'))));
  } finally { await outside.close(); }
  const dir = repository(); project(dir); global('continued');
  const pi = await start(dir, { mode: 'tui', lifecycle: true, ui: { select: async () => 'continued' } });
  try {
    await pi.session.prompt('/optchat profile');
    await pi.session.prompt('Keep this global choice');
    await pi.host!.newSession();
    assert.deepEqual(pi.bindings(), [{ name: 'continued' }]);
  } finally { await pi.close(); }
});
