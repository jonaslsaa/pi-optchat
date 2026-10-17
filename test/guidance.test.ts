import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Guidance, currentGuidance, type GuidanceState } from '../src/guidance.ts';
import { removeDir } from './support.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-'));
  const cwd = join(dir, 'project', 'child'), profile = join(dir, 'profile'), agent = join(dir, 'agent');
  for (const path of [cwd, profile, agent]) mkdirSync(path, { recursive: true });
  const source = join(dir, 'project', 'AGENTS.md');
  writeFileSync(source, 'Use SQLite.');
  const guidance = new Guidance(profile);
  let state: GuidanceState | undefined;
  let saves = 0;
  const messages: AgentMessage[] = [{ role: 'system', content: 'Stable instructions.', timestamp: 0 }, { role: 'user', content: '<chat>memory</chat>\nTask.', timestamp: 1 }];
  return { dir, cwd, profile, agent, source, guidance, messages, get state() { return state; }, get saves() { return saves; },
    prepare(input = messages) { return guidance.prepare(input, cwd, state, next => { state = next; saves++; }, agent); } };
}
const text = (messages: AgentMessage[]) => JSON.stringify(messages);

test('one complete revision per request, exact previous copy, stable unchanged requests and anchored transitions', () => {
  const f = fixture();
  try {
    const first = f.prepare();
    assert.match(text(first.messages), /Use SQLite/);
    assert.equal(first.messages.length, 2);
    const snapshots = () => readdirSync(join(f.profile, 'guidance', 'sources'), { recursive: true }).filter(p => String(p).endsWith('AGENTS.md'));
    assert.equal(snapshots().length, 1);
    utimesSync(f.source, new Date(), new Date(Date.now() + 10000));
    assert.deepEqual(f.prepare(), first);
    assert.equal(f.saves, 1);
    writeFileSync(f.source, 'Use PostgreSQL.');
    const changed = f.prepare();
    assert.equal(changed.messages.length, 3);
    assert.match(text(changed.messages[0] ? [changed.messages[0]] : []), /Use PostgreSQL/);
    assert.doesNotMatch(text([changed.messages[0]]), /Use SQLite/);
    const notice = text(changed.messages.slice(2));
    assert.match(notice, /previous excerpt.*SQLite.*current excerpt.*PostgreSQL/);
    assert.match(notice, /already supplied.*no manual reread/);
    assert.match(notice, /earlier instruction violation/);
    assert.equal(readFileSync(first.revision.files[0].archive, 'utf8'), 'Use SQLite.');
    assert.equal(snapshots().length, 2);
    assert.deepEqual(f.prepare(), changed);
    const next: AgentMessage = { role: 'user', content: 'Continue.', timestamp: 2 };
    const continued = f.prepare([...f.messages, next]);
    assert.deepEqual(continued.messages.slice(0, -1), changed.messages, 'the notice remains before subsequent work');
    assert.deepEqual(continued.messages.at(-1), next);
    // Context refresh/restart: the boundary has left the visible work, and is described as already applied.
    const restarted = new Guidance(f.profile).prepare([f.messages[0], next], f.cwd, f.state, () => assert.fail('unchanged revision'), f.agent);
    assert.match(text(restarted.messages), /Earlier guidance transition \(already applied, not a new change\)/);
    assert.equal(f.saves, 2);
  } finally { removeDir(f.dir); }
});

test('source priority, scope, additions, removal and reordering are effective changes; unobserved edits are not archived', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.agent, 'AGENTS.md'), 'Global.');
    writeFileSync(join(f.profile, 'AGENTS.md'), 'Profile.');
    assert.deepEqual(currentGuidance(f.cwd, f.profile, f.agent).map(s => s.supplied), ['Global.', 'Use SQLite.', 'Profile.']);
    const old = f.prepare();
    writeFileSync(f.source, 'Never observed.'); writeFileSync(f.source, 'Use SQLite.');
    assert.deepEqual(f.prepare(), old);
    const override = join(f.dir, 'project', 'AGENTS.override.md'); writeFileSync(override, 'Use SQLite.');
    const next = f.prepare();
    assert.notEqual(next.revision.id, old.revision.id);
    assert.match(text(next.messages), /no longer applies/);
    rmSync(override); renameSync(f.source, join(f.dir, 'moved.md'));
    const removed = f.prepare();
    assert.equal(removed.revision.files.length, 2);
    assert.equal(readFileSync(old.revision.files[1].archive, 'utf8'), 'Use SQLite.');
  } finally { removeDir(f.dir); }
});

test('BOM transformation keeps original bytes and the actual supplied text separately', () => {
  const f = fixture();
  try {
    writeFileSync(f.source, '\uFEFFUse SQLite.');
    const file = f.prepare().revision.files[0];
    assert.equal(readFileSync(file.archive, 'utf8'), '\uFEFFUse SQLite.');
    assert.equal(readFileSync(file.supplied, 'utf8'), 'Use SQLite.');
    assert.equal(JSON.parse(readFileSync(join(file.archive, '..', 'metadata.json'), 'utf8')).transformation, 'leading UTF-8 BOM removed');
  } finally { removeDir(f.dir); }
});

test('invalid, oversized, unreadable, racing or unpreservable guidance cannot advance the supplied revision', () => {
  const f = fixture();
  try {
    f.prepare(); const saved = f.state;
    writeFileSync(f.source, Buffer.from([0xff]));
    assert.throws(() => f.prepare(), /Cannot read current guidance/);
    writeFileSync(f.source, 'x'.repeat(1_000_001));
    assert.throws(() => f.prepare(), /exceeds/);
    rmSync(f.source); mkdirSync(f.source);
    assert.throws(() => f.prepare(), /not a regular file/);
    rmSync(f.source, { recursive: true }); writeFileSync(f.source, 'Changed.');
    rmSync(join(f.profile, 'guidance', 'sources'), { recursive: true });
    writeFileSync(join(f.profile, 'guidance', 'sources'), 'cannot write here');
    assert.throws(() => f.prepare());
    assert.equal(f.state, saved);
  } finally { removeDir(f.dir); }
});

test('a broken symlink is a failed source, not removal', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    rmSync(f.source); symlinkSync(join(f.dir, 'missing'), f.source);
    assert.throws(() => f.prepare(), /Cannot read current guidance/);
  } finally { removeDir(f.dir); }
});
