import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { Diagnostics, errorAttributes, startDiagnostics, stopDiagnostics, storageEvent, type Attributes, type LogRecord, type LogBatch } from '../src/diagnostics.ts';
import { modelDiagnostics } from '../src/model-diagnostics.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const directory = () => join(mkdtempSync(join(tmpdir(), 'diagnostics-')), 'logs');
const attributes = (record: LogRecord) => Object.fromEntries(record.attributes.map(a => [a.key, 'stringValue' in a.value ? a.value.stringValue : 'intValue' in a.value ? Number(a.value.intValue) : 'doubleValue' in a.value ? a.value.doubleValue : 'boolValue' in a.value ? a.value.boolValue : a.value.arrayValue.values]));
const records = (dir: string): LogRecord[] => !existsSync(dir) ? [] : readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(file => readFileSync(join(dir, file), 'utf8').trim().split('\n').filter(Boolean).flatMap(line => (JSON.parse(line) as LogBatch).resourceLogs.flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords))));
const text = (dir: string) => !existsSync(dir) ? '' : readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => readFileSync(join(dir, f), 'utf8')).join('');

// Validate the OTLP JSON subset we emit with an independent JSON Schema checker.
// This is not a protobuf binary roundtrip or a Collector ingestion test.
const str = Type.String();
const primitive = Type.Union([Type.Object({ stringValue: str }, { additionalProperties: false }), Type.Object({ intValue: Type.String({ pattern: '^-?[0-9]+$' }) }, { additionalProperties: false }), Type.Object({ doubleValue: Type.Number() }, { additionalProperties: false }), Type.Object({ boolValue: Type.Boolean() }, { additionalProperties: false })]);
const anyValue = Type.Union([primitive, Type.Object({ arrayValue: Type.Object({ values: Type.Array(primitive) }, { additionalProperties: false }) }, { additionalProperties: false })]);
const kv = Type.Object({ key: str, value: anyValue }, { additionalProperties: false });
const logSchema = Type.Object({ timeUnixNano: Type.String({ pattern: '^[0-9]+$' }), observedTimeUnixNano: Type.String({ pattern: '^[0-9]+$' }), severityNumber: Type.Integer({ minimum: 1, maximum: 24 }), severityText: str, eventName: str, body: anyValue, attributes: Type.Array(kv), traceId: Type.Optional(Type.String({ pattern: '^[0-9a-f]{32}$' })), spanId: Type.Optional(Type.String({ pattern: '^[0-9a-f]{16}$' })), droppedAttributesCount: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
const batchSchema = Type.Object({ resourceLogs: Type.Array(Type.Object({ resource: Type.Object({ attributes: Type.Array(kv) }), scopeLogs: Type.Array(Type.Object({ scope: Type.Object({ name: str, version: Type.Optional(str), attributes: Type.Array(kv) }), logRecords: Type.Array(logSchema) })) })) }, { additionalProperties: false });

test('native OTLP JSON envelopes have typed values, resource/scope, timestamps, severity and trace IDs', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir, version: '0.8.3', piVersion: '1.1.0', environment: 'test' });
  const span = d.begin('inference', { 'gen_ai.request.model': 'test-model', 'gen_ai.request.stream': true, 'gen_ai.usage.input_tokens': 123, 'optchat.operation.duration': 0.125, 'gen_ai.response.finish_reasons': ['stop'] });
  span.end(); await d.close();
  for (const line of text(dir).trim().split('\n')) {
    const batch = JSON.parse(line); assert.equal(Check(batchSchema, batch), true);
    assert.equal(batch.resourceLogs[0].scopeLogs[0].scope.version, '0.8.3');
    assert.equal(batch.resourceLogs[0].resource.attributes.find((a: { key: string }) => a.key === 'service.name').value.stringValue, 'pi');
  }
  const list = records(dir); assert.equal(list.length, 2);
  assert.equal(list[0].severityNumber, 5); assert.equal(list[0].traceId, list[1].traceId); assert.equal(list[0].spanId, list[1].spanId);
  assert.equal(attributes(list[0])['gen_ai.usage.input_tokens'], 123);
  assert.notEqual(list[0].traceId, '0'.repeat(32));
  if (process.platform !== 'win32') { assert.equal(statSync(dir).mode & 0o777, 0o700); for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600); }
});

test('privacy whitelist excludes content, secrets, paths, raw exceptions, hostile getters and inherited fields', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir, version: 'sk-seededSECRET' }); let reads = 0;
  const input = Object.assign(Object.create({ 'gen_ai.tool.name': 'inherited' }), {
    prompt: 'seededPROMPT', 'exception.message': 'seededERROR', 'authorization': 'Bearer seededAUTH',
    'gen_ai.request.model': '/private/seededPATH', 'gen_ai.response.id': 'sk-seededSECRET', 'gen_ai.response.model': 'safe-model',
    'http.response.header.x-request-id': ['Bearer seededHEADER'], '__proto__': 'seededPROTO',
  });
  Object.defineProperty(input, 'optchat.agent.id', { enumerable: true, get() { reads++; throw new Error('seededGETTER'); } });
  const reasons = ['stop']; Object.defineProperty(reasons, '0', { get() { reads++; return 'seededARRAY'; } });
  input['gen_ai.response.finish_reasons'] = reasons;
  const span = d.begin('inference', input); span.setAttributes(input); span.addEvent('optchat.summary.retry.scheduled', input); span.end('error', input, new Error('seededERROR sk-seededSECRET /private/seededPATH'));
  await d.close(); assert.equal(reads, 0);
  const output = text(dir); assert.ok(!output.includes('seeded')); assert.ok(!output.includes('inherited')); assert.ok(output.includes('safe-model')); assert.ok(records(dir).every(r => (r.droppedAttributesCount ?? 0) > 0));
  const error = new Error('seededERROR'); Object.defineProperty(error, 'name', { get() { reads++; throw error; } }); Object.defineProperty(error, 'code', { get() { reads++; throw error; } });
  assert.equal(errorAttributes(error)['error.type'], 'unknown'); assert.equal(reads, 0);
});

test('disabled diagnostics do no filesystem work; unknown names safely execute the original callback', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir }, false);
  d.event('optchat.runtime.started'); await d.startSpan({ name: 'optchat.inference' }, async s => { s.addEvent('anything'); return 123; }); await d.close(); assert.equal(existsSync(dir), false);
  const on = new Diagnostics({ directory: dir }); let calls = 0;
  assert.equal(await on.startSpan({ name: 'unknown', attributes: { prompt: 'seeded' } }, async () => { calls++; return 7; }), 7);
  on.event('unknown'); const hostile = new Proxy({}, { ownKeys() { throw new Error('seeded'); } });
  assert.doesNotThrow(() => on.begin('inference', hostile as Attributes).end());
  await on.close(); assert.equal(calls, 1); assert.equal(records(dir).length, 2);
});

test('sync/async errors preserve exact identity; cancellation, nested spans and eight parallel traces do not cross', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir }); const error = new Error('seeded');
  await assert.rejects(d.startSpan({ name: 'optchat.inference' }, () => { throw error; }), e => e === error);
  await assert.rejects(d.startSpan({ name: 'optchat.inference' }, async () => { throw error; }), e => e === error);
  await Promise.all(Array.from({ length: 8 }, (_, i) => d.startSpan({ name: 'optchat.summary.attempt', attributes: { 'optchat.summary.build_attempt': i + 1 } }, async parent => {
    await new Promise(r => setTimeout(r, i % 3));
    await parent.startSpan({ name: 'optchat.inference' }, async child => { child.setAttributes({ 'optchat.model.attempt': i + 1 }); });
  })));
  d.begin('memory.wait').end('cancelled'); await d.close();
  const list = records(dir), summaries = list.filter(r => r.eventName === 'optchat.summary.attempt.started'); assert.equal(new Set(summaries.map(s => s.traceId)).size, 8);
  for (const s of summaries) { const child = list.find(r => r.eventName === 'optchat.inference.started' && r.traceId === s.traceId)!; assert.equal(attributes(child)['optchat.parent.span_id'], s.spanId); }
  assert.equal(list.filter(r => attributes(r)['optchat.operation.outcome'] === 'error').length, 2); assert.equal(attributes(list.at(-1)!)['optchat.operation.outcome'], 'cancelled');
});

test('rotation splits batches on file size instead of dropping individually fitting records', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir, maxFileBytes: 2300, maxFiles: 30, maxDirectoryBytes: 100_000 });
  for (let i = 0; i < 40; i++) d.event('optchat.runtime.started', { 'optchat.records.count': i });
  await Promise.all([d.flush(), d.flush(), d.flush()]); await d.close();
  assert.equal(records(dir).length, 40); assert.equal(d.stats.droppedRecords, 0); assert.ok(readdirSync(dir).length > 1);
  for (const file of readdirSync(dir)) assert.ok(statSync(join(dir, file)).size <= 2300);
});

test('own rotation count and soft directory budget remain bounded; another active writer is never deleted', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir, maxFileBytes: 2200, maxFiles: 2, maxDirectoryBytes: 4400 });
  for (let i = 0; i < 15; i++) { d.event('optchat.runtime.started'); await d.flush(); }
  await d.close(); assert.equal(d.stats.droppedRecords, 0); assert.ok(readdirSync(dir).length <= 2);
  const foreign = join(dir, `${process.pid}-12345678-1234-1234-1234-123456789abc-0000.jsonl`); writeFileSync(foreign, 'foreign'.repeat(1000));
  const other = new Diagnostics({ directory: dir, maxDirectoryBytes: 3000 }); other.event('optchat.runtime.started'); await other.close();
  assert.ok(existsSync(foreign)); assert.equal(other.stats.droppedRecords, 1); assert.equal(other.stats.failed, false);
});

test('queue/record/file oversize drops are bounded and accounted once; warning callback cannot break the caller', async () => {
  const dir = directory(); let warnings = 0; const d = new Diagnostics({ directory: dir, maxQueueRecords: 2, warn() { warnings++; throw new Error('warn'); } });
  for (let i = 0; i < 6; i++) d.event('optchat.runtime.started');
  assert.equal(d.stats.droppedRecords, 4); await d.flush(); await d.close(); assert.equal(warnings, 1);
  const report = records(dir).find(r => r.eventName === 'optchat.diagnostics.records_dropped'); assert.equal(attributes(report!)['optchat.diagnostics.dropped_records'], 4);
  const tiny = new Diagnostics({ directory: directory(), maxRecordBytes: 10 }); tiny.event('optchat.runtime.started'); await tiny.close(); assert.equal(tiny.stats.droppedRecords, 1);
  const fileTiny = new Diagnostics({ directory: directory(), maxFileBytes: 10 }); fileTiny.event('optchat.runtime.started'); await fileTiny.close(); assert.equal(fileTiny.stats.droppedRecords, 1);
});

test('a drained batch is included in drop accounting on write failure, with no recursive warning loop', async () => {
  const dir = directory(); let warnings = 0; const d = new Diagnostics({ directory: dir, warn: () => { warnings++; } });
  const internal = d as unknown as { rotate(bytes: number): Promise<void>; file: { writeFile(text: string): Promise<void>; close(): Promise<void> } };
  const rotate = mock.method(internal, 'rotate', async () => { internal.file = { async writeFile() { throw Object.assign(new Error('seededENOSPC'), { code: 'ENOSPC' }); }, async close() {} }; });
  for (let i = 0; i < 45; i++) d.event('optchat.runtime.started'); await d.flush(); await d.close(); rotate.mock.restore();
  assert.equal(d.stats.droppedRecords, 45); assert.equal(d.stats.queuedRecords, 0); assert.equal(d.stats.failed, true); assert.equal(warnings, 1);
  assert.equal(await d.startSpan({ name: 'optchat.inference' }, () => 'original-result'), 'original-result');
  const original = new Error('original-error'); await assert.rejects(d.startSpan({ name: 'optchat.inference' }, () => { throw original; }), e => e === original);
});

test('configuration rejects NaN, infinity, zero, negative and fractional limits without a loop or crash', async () => {
  for (const invalid of [NaN, Infinity, 0, -1, 0.5]) {
    const dir = directory(), d = new Diagnostics({ directory: dir, maxFileBytes: invalid, maxFiles: invalid, maxQueueBytes: invalid, maxQueueRecords: invalid, maxRecordBytes: invalid, flushMs: invalid, shutdownMs: invalid, maxDirectoryBytes: invalid, retentionMs: invalid });
    d.event('optchat.runtime.started'); await d.close(); assert.equal(records(dir).length, 1); assert.equal(d.stats.droppedRecords, 0);
  }
});

test('close has a bounded timeout, shares its promise, drops queued data and does not write after timeout', async () => {
  const dir = directory(), d = new Diagnostics({ directory: dir, shutdownMs: 15 }); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const internal = d as unknown as { prepare(): Promise<void> }; const prepare = mock.method(internal, 'prepare', () => gate);
  d.event('optchat.runtime.started'); const begin = performance.now(); const closing = d.close(); assert.equal(d.close(), closing); await closing;
  assert.ok(performance.now() - begin < 300); assert.equal(d.stats.droppedRecords, 1); d.event('optchat.runtime.started'); release(); await d.flush(); prepare.mock.restore(); assert.equal(existsSync(dir), false);
});

test('profile and symlink destinations fail closed before creating profile logfiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostics-')), dir = join(root, 'profiles', 'demo', 'diagnostics');
  const d = new Diagnostics({ directory: dir }); d.event('optchat.runtime.started'); await d.close(); assert.equal(d.stats.failed, true); assert.equal(existsSync(join(root, 'profiles')), false);
  if (process.platform !== 'win32') { const target = join(root, 'target'); mkdirSync(target); const link = join(root, 'link'); symlinkSync(target, link); const linked = new Diagnostics({ directory: link }); linked.event('optchat.runtime.started'); await linked.close(); assert.equal(linked.stats.failed, true); assert.deepEqual(readdirSync(target), []); }
});

test('opt-in stores only outside profiles; provider usage/cache/reasoning, headers, unknown usage and storage errors are safe', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diagnostics-home-')), before = process.env.OPTCHAT_HOME, enabled = process.env.OPTCHAT_DIAGNOSTICS;
  process.env.OPTCHAT_HOME = home; delete process.env.OPTCHAT_DIAGNOSTICS;
  assert.equal(startDiagnostics().enabled, false); assert.deepEqual(readdirSync(home), []);
  process.env.OPTCHAT_DIAGNOSTICS = '1'; startDiagnostics('0.8.3');
  try {
    const diag = modelDiagnostics({ provider: 'openai-codex', id: 'safe-model' });
    diag.options.onResponse({ status: 200, headers: { 'x-request-id': 'req_123', authorization: 'Bearer seededAUTH', cookie: 'seededCOOKIE' } });
    diag.observe('start'); diag.observe('text_delta');
    const reply = { stopReason: 'stop', rawStopReason: 'stop', responseId: 'resp_123', responseModel: 'actual-model', content: [{ type: 'text', text: 'seededREPLY' }], usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5 } } as unknown as AssistantMessage;
    diag.finish(reply); diag.finish(reply);
    const unknown = modelDiagnostics({ provider: 'openai', id: 'safe-model' }); unknown.finish({ ...reply, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as AssistantMessage);
    const cancelled = modelDiagnostics({ provider: 'openai', id: 'safe-model' }); cancelled.finish(undefined, true);
    const storageError = Object.assign(new Error('seededERROR'), { code: 'ENOSPC' });
    assert.equal(storageEvent('memory_log', () => 123), 123);
    assert.throws(() => storageEvent('memory_log', () => { throw storageError; }), e => e === storageError);
    await assert.rejects(storageEvent('summary_node', async () => { throw storageError; }), e => e === storageError);
  } finally { await stopDiagnostics(); process.env.OPTCHAT_HOME = before; if (enabled === undefined) delete process.env.OPTCHAT_DIAGNOSTICS; else process.env.OPTCHAT_DIAGNOSTICS = enabled; }
  assert.deepEqual(readdirSync(home), ['diagnostics']); const list = records(join(home, 'diagnostics'));
  const completed = list.filter(r => r.eventName === 'gen_ai.client.inference.operation.details'); assert.equal(completed.length, 3);
  const a = attributes(completed[0]); assert.equal(a['gen_ai.usage.input_tokens'], 80); assert.equal(a['gen_ai.usage.output_tokens'], 20); assert.equal(a['gen_ai.usage.reasoning.output_tokens'], 5); assert.ok(a['optchat.model.time_to_first_event'] !== undefined);
  assert.equal(attributes(completed[1])['optchat.usage.availability'], 'unknown'); assert.equal(attributes(completed[1])['gen_ai.usage.input_tokens'], undefined); assert.equal(attributes(completed[2])['optchat.operation.outcome'], 'cancelled');
  assert.equal(list.filter(r => r.eventName === 'optchat.storage.failed').length, 2); assert.ok(!text(join(home, 'diagnostics')).includes('seeded'));
});

test('local deadlines, provider timeouts and generic aborts have distinct metadata without error text', async () => {
  const { diagnosticCancelled, signalDiagnosticAttributes } = await import('../src/diagnostics.ts');
  const home = mkdtempSync(join(tmpdir(), 'diagnostics-causes-')), before = process.env.OPTCHAT_HOME, enabled = process.env.OPTCHAT_DIAGNOSTICS;
  process.env.OPTCHAT_HOME = home; process.env.OPTCHAT_DIAGNOSTICS = '1'; startDiagnostics();
  try {
    const deadline = AbortSignal.abort(new DOMException('seededDEADLINE', 'TimeoutError'));
    const abort = AbortSignal.abort(new DOMException('seededABORT', 'AbortError'));
    assert.equal(diagnosticCancelled(deadline), false); assert.equal(diagnosticCancelled(abort), true);
    assert.equal(diagnosticCancelled(AbortSignal.abort('seededUNKNOWN')), true);
    const local = modelDiagnostics({ provider: 'openai', id: 'fixture' }); local.finish(undefined, diagnosticCancelled(deadline), deadline.reason, signalDiagnosticAttributes(deadline));
    const user = modelDiagnostics({ provider: 'openai', id: 'fixture' }); user.finish(undefined, diagnosticCancelled(abort), abort.reason, signalDiagnosticAttributes(abort));
    const remote = modelDiagnostics({ provider: 'openai', id: 'fixture' }); remote.finish(undefined, false, Object.assign(new Error('seededPROVIDER'), { code: 'ETIMEDOUT' }));
    const unknown = modelDiagnostics({ provider: 'openai', id: 'fixture' }); unknown.finish({ stopReason: 'aborted' } as AssistantMessage);
  } finally { await stopDiagnostics(); process.env.OPTCHAT_HOME = before; if (enabled === undefined) delete process.env.OPTCHAT_DIAGNOSTICS; else process.env.OPTCHAT_DIAGNOSTICS = enabled; }
  const list = records(join(home, 'diagnostics')).filter(r => r.eventName === 'gen_ai.client.inference.operation.details');
  assert.equal(attributes(list[0])['optchat.operation.outcome'], 'error'); assert.equal(attributes(list[0])['error.type'], 'timeout'); assert.equal(attributes(list[0])['optchat.error.source'], 'deadline');
  assert.equal(attributes(list[1])['optchat.operation.outcome'], 'cancelled'); assert.equal(attributes(list[1])['optchat.cancellation.reason'], 'abort_signal'); assert.equal(attributes(list[1])['error.type'], undefined);
  assert.equal(attributes(list[2])['optchat.operation.outcome'], 'error'); assert.equal(attributes(list[2])['error.type'], 'timeout'); assert.equal(attributes(list[2])['optchat.error.source'], 'provider'); assert.equal(attributes(list[3])['optchat.operation.outcome'], 'cancelled'); assert.equal(attributes(list[3])['optchat.cancellation.reason'], 'unknown'); assert.ok(!text(join(home, 'diagnostics')).includes('seeded'));
});

test('memory retry/build/cache/model/store/wait share safe identities and distinguish attempt from turn', async () => {
  const { Memory } = await import('../src/memory.ts');
  const home = mkdtempSync(join(tmpdir(), 'diagnostics-memory-')), before = process.env.OPTCHAT_HOME, enabled = process.env.OPTCHAT_DIAGNOSTICS;
  process.env.OPTCHAT_HOME = home; process.env.OPTCHAT_DIAGNOSTICS = '1'; const d = startDiagnostics(); let attempts = 0;
  const profile = d.begin('profile.open', { 'optchat.profile.id': 'opaque_profile', 'optchat.session.id': 'session_123', 'optchat.agent.id': 'agent_123' });
  const memory = profile.run(() => new Memory(join(home, 'profiles', 'demo'), async () => {
    const waiting = d.begin('cache.wait'); waiting.end();
    const model = modelDiagnostics({ provider: 'openai', id: 'fixture' }, { 'optchat.role': 'compactor', 'optchat.model.attempt': 1 });
    if (++attempts === 1) { const error = Object.assign(new Error('seededERROR'), { code: 'ECONNRESET' }); model.finish(undefined, false, error); throw error; }
    model.finish(); return 'safe short summary';
  }, () => {}, 128000, 8, 15)); profile.end();
  try {
    memory.append('user', 'seededPROMPT '.repeat(500));
    await memory.settle(AbortSignal.timeout(2000), 'turn', { 'optchat.turn.id': 'turn_123' });
    await memory.settle(AbortSignal.timeout(2000), 'tree', { 'optchat.turn.id': 'turn_456' });
    assert.equal(attempts, 2);
  } finally { await memory.close(); await stopDiagnostics(); process.env.OPTCHAT_HOME = before; if (enabled === undefined) delete process.env.OPTCHAT_DIAGNOSTICS; else process.env.OPTCHAT_DIAGNOSTICS = enabled; }
  const list = records(join(home, 'diagnostics')), builds = list.filter(r => r.eventName === 'optchat.summary.attempt.started');
  assert.equal(builds.length, 2); assert.deepEqual(builds.map(b => attributes(b)['optchat.summary.build_attempt']), [1, 2]);
  assert.notEqual(builds[0].traceId, builds[1].traceId); const generation = attributes(builds[0])['optchat.memory.generation.id'];
  for (const r of list.filter(r => /summary\.attempt|inference|cache\.wait|memory\.wait|storage/.test(r.eventName))) {
    const a = attributes(r); assert.equal(a['optchat.session.id'], 'session_123'); assert.equal(a['optchat.agent.id'], 'agent_123'); assert.equal(a['optchat.profile.id'], 'opaque_profile'); assert.equal(a['optchat.memory.generation.id'], generation);
  }
  for (const b of builds) {
    const models = list.filter(r => r.eventName === 'optchat.inference.started' && r.traceId === b.traceId); assert.equal(models.length, 1); assert.equal(attributes(models[0])['optchat.summary.build_attempt'], attributes(b)['optchat.summary.build_attempt']);
    assert.equal(attributes(models[0])['optchat.model.attempt'], 1); assert.equal(attributes(models[0])['optchat.parent.span_id'], b.spanId); assert.equal(attributes(models[0])['optchat.turn.id'], undefined, 'independent background builds are not children of a later waiting turn');
  }
  const waits = list.filter(r => r.eventName === 'optchat.memory.wait.completed'); assert.equal(attributes(waits[0])['optchat.memory.wait.result'], 'stalled'); assert.equal(attributes(waits[1])['optchat.memory.wait.result'], 'ready'); assert.equal(attributes(waits[1])['optchat.turn.id'], 'turn_456');
  const stored = list.findIndex(r => r.eventName === 'optchat.storage.completed' && attributes(r)['optchat.storage.operation'] === 'summary_node');
  const completed = list.findIndex(r => r.eventName === 'optchat.summary.attempt.completed' && attributes(r)['optchat.operation.outcome'] === 'success'); assert.ok(stored < completed); assert.ok(!text(join(home, 'diagnostics')).includes('seeded'));
});

test('current compactor and handoff retain transient retries and refusal behavior with diagnostics on and off', async () => {
  const { ModelRuntime, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const { createCompressor } = await import('../src/compactor.ts');
  const { createHandoffSummarizer } = await import('../src/handoff.ts');
  const { Memory, SOURCE } = await import('../src/memory.ts');
  const { emptyUsage } = await import('../src/usage.ts');
  const { COMPACT } = await import('../src/prompts.ts');
  const before = process.env.OPTCHAT_HOME, enabled = process.env.OPTCHAT_DIAGNOSTICS;
  try {
    for (const on of [false, true]) {
      const home = mkdtempSync(join(tmpdir(), 'diagnostics-port-'));
      process.env.OPTCHAT_HOME = home;
      process.env.OPTCHAT_DIAGNOSTICS = on ? '1' : '0';
      startDiagnostics('0.8.9');
      const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null, modelsStorePath: join(home, 'models.json'), refreshOnCreate: false });
      let phase: 'compactor' | 'handoff' | 'refusal' = 'compactor', calls = 0, sourceLength = 0;
      const usage: AssistantMessage[] = [];
      runtime.registerProvider('fixture', {
        baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages',
        models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
        streamSimple(model, context, options) {
          calls++;
          assert.equal(context.messages.some(m => m.role === 'system' && m.content === COMPACT), phase !== 'handoff');
          assert.equal(options?.signal?.aborted, false);
          const failed = phase === 'refusal' || calls === 1;
          const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: phase === 'handoff' ? 'Safe handoff.' : 'Safe summary.' }], api: model.api,
            provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: failed ? 'error' : 'stop', usage: emptyUsage(),
            ...(failed ? { errorMessage: phase === 'refusal' ? 'seededREFUSAL' : 'terminated', ...(phase === 'refusal' ? { rawStopReason: 'refusal' } : {}) } : {}) };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            if (failed) stream.push({ type: 'error', reason: 'error', error: message });
            else stream.push({ type: 'done', reason: 'stop', message });
            stream.end();
          });
          return stream;
        },
      });
      const choice = () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' as const });
      const registry = new ModelRegistry(runtime);
      const compress = createCompressor(registry, choice, message => usage.push(message), undefined, [0, 0]);
      assert.equal(await compress({ context: '<chat>\n</chat>', source: 'seededSOURCE'.repeat(100), part: { l: 0, i: 0 } }, new AbortController().signal), 'Safe summary.');
      assert.equal(calls, 2); assert.equal(usage.length, 2);
      phase = 'handoff'; calls = 0;
      const summarize = createHandoffSummarizer(registry, choice, message => usage.push(message), [0, 0]);
      assert.equal(await summarize({ id: 'agent_fixture', task: 'seededTASK', cwd: home, model: 'fixture/fixture', thinking: 'off', parentSession: 'fixture', started: 0, depth: 1, state: 'completed', guidance: [] }, []), 'Safe handoff.');
      assert.equal(calls, 2); assert.equal(usage.length, 4);
      phase = 'refusal'; calls = 0;
      const memoryPath = join(home, 'profiles', 'fixture', 'main');
      const memory = new Memory(memoryPath, input => { sourceLength = input.source.length; return compress(input, new AbortController().signal); }, () => {});
      try {
        memory.append('user', 'seededSOURCE'.repeat(10000));
        await memory.settle(AbortSignal.timeout(5000), 'tree');
        assert.equal(calls, 1); assert.ok(sourceLength <= SOURCE);
        assert.match(memory.render(), /not summarized: zoom it/);
      } finally { await memory.close(); }
      const saved = JSON.parse(readFileSync(join(memoryPath, 'view.json'), 'utf8'));
      assert.ok(Array.isArray(saved.parts) && Array.isArray(saved.compaction.parts));
      const reopened = new Memory(memoryPath, async () => { throw new Error('Unexpected rebuild'); }, () => {});
      try { await reopened.settle(AbortSignal.timeout(5000), 'tree'); assert.equal(reopened.render(), memory.render()); } finally { await reopened.close(); }
      const resaved = JSON.parse(readFileSync(join(memoryPath, 'view.json'), 'utf8'));
      assert.ok(Array.isArray(resaved.parts) && Array.isArray(resaved.compaction.parts));
      assert.equal(typeof resaved.merging, 'boolean'); assert.equal(typeof resaved.compaction.merging, 'boolean');
      await stopDiagnostics();
      const list = records(join(home, 'diagnostics'));
      if (!on) { assert.equal(list.length, 0); assert.equal(existsSync(join(home, 'diagnostics')), false); continue; }
      assert.equal(list.filter(r => r.eventName === 'optchat.model.retry.scheduled').length, 2);
      const inference = list.filter(r => r.eventName === 'gen_ai.client.inference.operation.details');
      assert.deepEqual(inference.map(r => attributes(r)['optchat.operation.outcome']), ['error', 'success', 'error', 'success', 'error']);
      assert.deepEqual(inference.map(r => attributes(r)['optchat.model.attempt']), [1, 2, 1, 2, 1]);
      assert.equal(list.filter(r => r.eventName === 'optchat.summary.fallback').length, 1);
      assert.ok(!text(join(home, 'diagnostics')).includes('seeded'));
      assert.ok(!text(join(home, 'diagnostics')).includes(home));
    }
  } finally {
    await stopDiagnostics();
    if (before === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = before;
    if (enabled === undefined) delete process.env.OPTCHAT_DIAGNOSTICS; else process.env.OPTCHAT_DIAGNOSTICS = enabled;
  }
});
