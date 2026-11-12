import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { ROLE_STATUS } from '../src/rpc-window.ts';
import { removeDir } from './support.ts';

// Real `pi --mode rpc` processes, as T3 Code or the OptChat app start one per thread or window, on a throwaway profile.
const root = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'oc-rpcp-') : '/tmp/oc-rpcp-');
const oldHome = process.env.OPTCHAT_HOME;
const env = { ...process.env, OPTCHAT_HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent') };
process.env.OPTCHAT_HOME = env.OPTCHAT_HOME;
const started: ChildProcess[] = [];
after(() => {
  for (const child of started) child.kill('SIGKILL'); // Only the processes this test started.
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'cli.js');

type Event = Record<string, unknown>;
function pi(profile: string) {
  const cwd = mkdtempSync(join(root, 'cwd-'));
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '-ne', '-ns', '-np', '-nc', '--no-themes', '--no-tools',
    '-e', join(here, '..', 'src', 'index.ts'), '-e', join(here, 'fixtures', 'rpc-provider.ts'),
    '--provider', 'fixture', '--model', 'fixture', '--session-dir', join(cwd, 'sessions'), '--optchat-profile', profile], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
  started.push(child);
  // Sent at once: Pi reads commands only after session_start, so a host's first answer already follows the role.
  child.stdin!.write(`${JSON.stringify({ id: 'first', type: 'get_state' })}\n`);
  const events: Event[] = [];
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (text: string) => {
    buffer += text;
    for (let at; (at = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(at + 1)) try { events.push(JSON.parse(buffer.slice(0, at))); } catch {}
  });
  const roles = () => events.flatMap(e => e.method === 'setStatus' && e.statusKey === ROLE_STATUS && typeof e.statusText === 'string' ? [JSON.parse(e.statusText) as Event] : []);
  return {
    child, events, role: () => roles().at(-1),
    /** Whether the role came before the answer to the host's first command. */
    roleFirst: () => {
      const role = events.findIndex(e => e.method === 'setStatus' && e.statusKey === ROLE_STATUS), answer = events.findIndex(e => e.type === 'response' && e.id === 'first');
      return role >= 0 && answer > role;
    },
    prompt: (message: string) => child.stdin!.write(`${JSON.stringify({ type: 'prompt', message })}\n`),
    /** Every text the process showed or answered, for matching. */
    text: () => JSON.stringify(events),
  };
}
async function until(what: string, predicate: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test('two real pi --mode rpc processes on one profile: the second is a window, /complete and a hard kill both reach the owner', { timeout: 120_000 }, async () => {
  mkdirSync(env.OPTCHAT_HOME, { recursive: true });
  createProfile('work');
  saveConfig(profilePath('work'), { ...loadConfig(profilePath('work')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const owner = pi('work');
  await until('the owner role', () => owner.role()?.role === 'owner');
  await until('the owner state', () => owner.events.some(e => e.id === 'first'));
  assert.ok(owner.roleFirst(), 'a host knows the role when its first get_state returns');
  owner.prompt('The colour is teal.');
  await until('the owner reply', () => owner.text().includes('Reply: The colour is teal.'));

  const window = pi('work');
  await until('the window role', () => window.role()?.role === 'window');
  assert.equal(window.role()?.connected, true);
  await until('the window state', () => window.events.some(e => e.id === 'first'));
  assert.ok(window.roleFirst(), 'a host knows it got a window when its first get_state returns');
  window.prompt('What colour?');
  await until('the window reply', () => window.text().includes('Reply: What colour?'));
  window.prompt('/complete');
  await until('the window completed', () => window.role()?.completed === true);
  await until('the handoff in the owner', () => owner.text().includes('completed by user') && owner.text().includes('Handoff: the user asked about the colour'));
  // T3 Code sends the next message to the same process: it starts a new connected conversation instead of hanging.
  const done = window.role()?.id;
  window.prompt('Next topic?');
  await until('the next conversation\'s reply', () => window.text().includes('Reply: Next topic?'));
  assert.ok(window.role()?.id !== done && window.role()?.completed === false, 'a new window id, not completed');
  assert.ok(!window.events.some(e => e.type === 'extension_error'), 'Pi accepted every request the window shaped');

  const killed = pi('work');
  await until('the second window role', () => killed.role()?.role === 'window');
  killed.prompt('Remember the tide table.');
  await until('the second window reply', () => killed.text().includes('Reply: Remember the tide table.'));
  killed.child.kill('SIGKILL');
  await until('the interrupted handoff in the owner', () => owner.text().includes('interrupted (disconnected)') && /Summary: .*Remember the tide table/s.test(owner.text()));
  assert.ok(!owner.text().includes('Profile already running'), 'neither window failed on the busy profile');
});
