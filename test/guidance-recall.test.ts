import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager, serializeConversation, convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Guidance, currentGuidance } from '../src/guidance.ts';
import { GuidanceRequests, GUIDANCE_REQUEST, transcriptGuidance, withGuidanceRecall } from '../src/guidance-recall.ts';
import { Memory } from '../src/memory.ts';
import { memoryTools } from '../src/tools.ts';
import { logMessage, runTranscript, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { prepareImport, runImport, memoryDirectory } from '../src/import/job.ts';
import { removeDir } from './support.ts';

const user: AgentMessage = { role: 'user', content: 'Build the database.', timestamp: 1 };
const reply: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'Built the database.' }], timestamp: 2, stopReason: 'stop', api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage() };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-recall-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
  mkdirSync(cwd); mkdirSync(profile); const source = join(cwd, 'AGENTS.md'); writeFileSync(source, 'Use SQLite.');
  const requests = new GuidanceRequests(profile), guidance = new Guidance(profile);
  const revision = () => guidance.archive.preserve(currentGuidance(cwd, profile, join(dir, 'agent')));
  return { dir, cwd, profile, source, requests, guidance, revision };
}

test('original-message recall survives restart, source moves/deletion and rebuilt memory without summarizing annotations', async () => {
  const f = fixture(), summaries: string[] = [];
  const compress = async (input: { source: string; context: string }) => { summaries.push(input.source + input.context); return 'Summary.'; };
  let memory = new Memory(f.profile, compress);
  try {
    const old = f.revision(), input = f.requests.input();
    logMessage(memory, user, undefined, input);
    assert.deepEqual(f.requests.prepare(old, 'main', [user]), input);
    logMessage(memory, reply, undefined, f.requests.latest);
    writeFileSync(f.source, 'Use PostgreSQL.');
    const current = f.revision(), latest = f.requests.prepare(current, 'main', [reply]);
    logMessage(memory, { ...reply, timestamp: 3 }, undefined, latest);
    await memory.settle(undefined, 'tree'); await memory.close();
    renameSync(f.source, join(f.dir, 'moved.md')); rmSync(join(f.dir, 'moved.md'));
    memory = await Memory.open(f.profile, compress);
    const restored = new GuidanceRequests(f.profile);
    const zoom = memoryTools(() => memory, undefined, { run: () => new Map() })[0];
    const result = await zoom.execute('recall', { id: 1 });
    assert.doesNotMatch(textContent(result.content), /historical_guidance/);
    const message: AgentMessage = { role: 'toolResult', toolCallId: 'recall', toolName: 'zoom', isError: false, ...result, timestamp: 4 };
    const annotated = withGuidanceRecall([message], refs => restored.describe(refs));
    assert.equal(annotated[0].role, 'toolResult');
    assert.match(textContent(annotated[0].content), /historical_guidance/);
    assert.match(textContent(annotated[0].content), new RegExp(input.request));
    assert.ok(textContent(annotated[0].content).includes(old.files[0].archive));
    assert.equal(readFileSync(old.files[0].archive, 'utf8'), 'Use SQLite.');
    assert.doesNotMatch(textContent(annotated[0].content), new RegExp(latest.request));
    logMessage(memory, message, undefined, latest);
    await memory.settle(undefined, 'tree');
    assert.doesNotMatch(summaries.join('\n') + memory.render(), /historical_guidance|guidance\/sources/);
    assert.doesNotMatch(serializeConversation(convertToLlm([message])), /historical_guidance|guidance\/sources|optchatGuidanceRecall/, 'Pi compaction sees only canonical tool text too');
    const summary = await zoom.execute('summary', { id: 0, n: 2 });
    assert.deepEqual(summary.details, {}, 'summary zoom is never automatically annotated');
    // Rebuild renumbers native messages; metadata must travel with those messages, not their former ids.
    await prepareImport(f.profile, memory, [{ kind: 'user', text: 'Older imported input.', date: '1970-01-01T00:00:00.000Z', receipt: 'import:old' }], 'rebuild');
    await memory.close();
    await runImport(f.profile, compress, new AbortController().signal);
    memory = await Memory.open(memoryDirectory(f.profile), compress);
    const native = memory.root.find(e => e.text === 'Built the database.' && e.date === new Date(2).toISOString())!;
    assert.equal(native.guidance?.request, input.request);
    assert.ok(restored.describe([native.guidance!]).includes(old.files[0].archive));
  } finally { await memory.close(); removeDir(f.dir); }
});

test('parallel agents receive independently associated snapshots; retained transcript boundaries survive compaction and reload', () => {
  const f = fixture();
  try {
    const old = f.revision(), first = f.requests.prepare(old, 'child-A', [user]);
    writeFileSync(f.source, 'Use PostgreSQL.');
    const current = f.revision(), second = f.requests.prepare(current, 'child-B', [user]);
    assert.notEqual(first.request, second.request);
    const manager = SessionManager.create(f.cwd, join(f.dir, 'sessions'));
    manager.appendMessage(user); manager.appendCustomEntry(GUIDANCE_REQUEST, first); manager.appendMessage(reply);
    const u = manager.appendMessage({ ...user, content: 'Continue.', timestamp: 3 });
    manager.appendCustomEntry(GUIDANCE_REQUEST, second); manager.appendMessage({ ...reply, timestamp: 4 });
    manager.appendCompaction('Earlier work summarized.', u, 1000);
    const entries = SessionManager.open(manager.getSessionFile()!).getEntries(), refs = transcriptGuidance(entries);
    assert.deepEqual([...refs.values()], [first, first, second, second]);
    assert.match(f.requests.describe([refs.get(1)!]), /agent child-A/);
    assert.match(f.requests.describe([refs.get(3)!]), /agent child-B/);
    const streamed = { ...reply, timestamp: 5 };
    assert.deepEqual(transcriptGuidance(entries, streamed).get(4), second);
  } finally { removeDir(f.dir); }
});

test('paged child recall includes only the requests accompanying that page, without changing offsets or stored transcript', async () => {
  const f = fixture(), memory = new Memory(f.profile, async () => 'Summary.');
  try {
    const a = f.requests.prepare(f.revision(), 'child', [user]);
    writeFileSync(f.source, 'Use PostgreSQL.'); const b = f.requests.prepare(f.revision(), 'child', [reply]);
    const messages = [user, reply], plain = runTranscript(messages), at = plain.indexOf('talk|');
    const zoom = memoryTools(() => memory, () => messages, { run: () => new Map([[0, a], [1, b]]) })[0];
    const page = await zoom.execute('call', { id: 'child', offset: at, limit: 10 });
    assert.equal(textContent(page.content), `${plain.slice(at, at + 10)}\n[characters ${at}-${at + 10} of ${plain.length}; go on with offset ${at + 10}]`);
    assert.match(JSON.stringify(page.details), new RegExp(b.request));
    assert.ok(JSON.stringify(page.details).includes(`run child, characters ${at}-${plain.length}`), 'the archive reference identifies its original work span');
    assert.doesNotMatch(JSON.stringify(page.details), new RegExp(a.request));
    assert.doesNotMatch(runTranscript(messages), /historical_guidance/);
  } finally { await memory.close(); removeDir(f.dir); }
});

test('missing request records are explicit, corrupt or missing archives fail honestly, and reading history never activates it', () => {
  const f = fixture();
  try {
    assert.match(f.requests.describe([f.requests.input()]), /may not have reached/);
    const old = f.revision(), ref = f.requests.prepare(old, 'main', [user]);
    writeFileSync(f.source, 'Use PostgreSQL.');
    const before = f.guidance.prepare([{ role: 'system', content: 'Stable.', timestamp: 0 }, user], f.cwd, undefined, () => {});
    f.requests.describe([ref]);
    const after = f.guidance.prepare([{ role: 'system', content: 'Stable.', timestamp: 0 }, user], f.cwd, undefined, () => {});
    assert.deepEqual(after, before);
    writeFileSync(old.files[0].archive, 'tampered');
    assert.throws(() => f.requests.describe([ref]), /Damaged historical guidance/);
    rmSync(old.files[0].archive);
    assert.throws(() => f.requests.describe([ref]), /ENOENT/);
  } finally { removeDir(f.dir); }
});

test('moving the profile preserves request recall and reconstructs transition links at the new archive location', () => {
  const f = fixture();
  try {
    const messages: AgentMessage[] = [{ role: 'system', content: 'Stable.', timestamp: 0 }, user];
    let state: Parameters<Guidance['prepare']>[2];
    const old = f.guidance.prepare(messages, f.cwd, state, next => { state = next; });
    const ref = f.requests.prepare(old.revision, 'main', [user]);
    writeFileSync(f.source, 'Use PostgreSQL.');
    f.guidance.prepare(messages, f.cwd, state, next => { state = next; });
    const moved = join(f.dir, 'moved-profile'); renameSync(f.profile, moved);
    const guidance = new Guidance(moved), requests = new GuidanceRequests(moved);
    const described = requests.describe([ref]);
    assert.ok(described.includes(join(moved, 'guidance', 'sources')));
    assert.ok(!described.includes(join(f.profile, 'guidance', 'sources')));
    const next = guidance.prepare(messages, f.cwd, state, () => assert.fail('same effective revision'));
    assert.ok(next.messages.some(message => 'content' in message && textContent(message.content).includes(join(moved, 'guidance', 'sources'))));
    const file = guidance.archive.revision(old.revision.id).files[0];
    assert.equal(readFileSync(file.archive, 'utf8'), 'Use SQLite.');
  } finally { removeDir(f.dir); }
});


test('working inside a preserved source folder cannot turn its AGENTS.md into current guidance', () => {
  const f = fixture();
  try {
    const old = f.revision();
    writeFileSync(join(f.profile, 'AGENTS.md'), 'Use PostgreSQL.');
    const sources = currentGuidance(join(old.files[0].archive, '..'), f.profile, join(f.dir, 'agent'));
    assert.ok(sources.some(source => source.supplied === 'Use PostgreSQL.'));
    assert.ok(!sources.some(source => source.supplied === 'Use SQLite.'));
  } finally { removeDir(f.dir); }
});
