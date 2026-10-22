import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdir, open, readdir, lstat, unlink, realpath, type FileHandle } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { SpanAttributes, SpanOptions, SpanStatus, TelemetryContext, TelemetrySpan } from '@earendil-works/pi-telemetry';

/** Local OTLP logs, not an exporter. No payloads, arbitrary errors, paths or request bodies enter this vocabulary. */
export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const GENAI_REVISION = '6fd0d763a092db245a54104fc1124031eb3c51d2';
export type Attributes = SpanAttributes;
type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };
export interface LogRecord {
  timeUnixNano: string; observedTimeUnixNano: string; severityNumber: number; severityText: string; eventName: string;
  body: { stringValue: string }; attributes: KeyValue[]; traceId?: string; spanId?: string; droppedAttributesCount?: number;
}
export interface LogBatch { resourceLogs: { resource: { attributes: KeyValue[] }; scopeLogs: { scope: { name: string; version?: string; attributes: KeyValue[] }; logRecords: LogRecord[] }[] }[] }
export interface DiagnosticOptions {
  directory: string; version?: string; piVersion?: string; environment?: 'development' | 'test' | 'production';
  warn?: () => void; maxFileBytes?: number; maxFiles?: number; maxDirectoryBytes?: number; retentionMs?: number;
  maxQueueBytes?: number; maxQueueRecords?: number; maxRecordBytes?: number; flushMs?: number; shutdownMs?: number;
}
const severities = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const;
type Level = keyof typeof severities;
const secret = /(?:bearer|password|secret|api[_-]?key|token[=:]|\bsk[-_]|\bgh[pousr]_|-----BEGIN)/i;
const name = (v: string) => v.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._+:/-]*$/.test(v) && !/^(?:[a-zA-Z]:|\/)|\.\.|(?:\/[^/]+){3}/.test(v) && !secret.test(v);
const id = (v: string) => v.length <= 160 && /^[a-zA-Z0-9_-]+$/.test(v) && !secret.test(v);
const enumeration = (...values: string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const identifier = (v: unknown) => typeof v === 'string' && id(v);
const named = (v: unknown) => typeof v === 'string' && name(v);
const bool = (v: unknown) => typeof v === 'boolean';
/** Unknown attributes are dropped rather than stringified. Keep this closed and covered by privacy tests. */
const fields: Record<string, (v: unknown) => boolean> = {
  'gen_ai.operation.name': enumeration('chat', 'generate_content', 'text_completion'),
  'gen_ai.provider.name': named, 'gen_ai.request.model': named, 'gen_ai.response.model': named,
  'gen_ai.response.id': identifier, 'gen_ai.conversation.id': identifier, 'gen_ai.request.stream': bool,
  'gen_ai.request.reasoning.level': enumeration('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
  'gen_ai.response.finish_reasons': v => Array.isArray(v) && v.length <= 8 && v.every(x => typeof x === 'string' && ['stop', 'length', 'toolUse', 'tool_use', 'tool_calls', 'end_turn', 'stop_sequence', 'max_tokens', 'error', 'deferred'].includes(x)),
  'gen_ai.usage.input_tokens': number, 'gen_ai.usage.output_tokens': number,
  'gen_ai.usage.cache_read.input_tokens': number, 'gen_ai.usage.cache_write.input_tokens': number, 'gen_ai.usage.reasoning.output_tokens': number,
  'gen_ai.tool.name': named, 'gen_ai.tool.call.id': identifier,
  'http.response.status_code': v => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
  'error.type': enumeration('timeout', 'rate_limit', 'authentication', 'quota', 'network', 'stream_incomplete', 'invalid_response', 'storage', 'unknown'),
  'exception.type': enumeration('Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError'),
  'optchat.role': enumeration('main', 'subagent', 'compactor', 'import', 'handoff', 'client'),
  'optchat.profile.id': identifier, 'optchat.turn.id': identifier, 'optchat.session.id': identifier, 'optchat.agent.id': identifier, 'optchat.parent.agent.id': identifier,
  'optchat.parent.span_id': v => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v),
  'optchat.operation.phase': enumeration('start', 'end', 'event'), 'optchat.operation.outcome': enumeration('success', 'error', 'cancelled'),
  'optchat.cancellation.reason': enumeration('abort_signal', 'shutdown', 'user', 'unknown'),
  'optchat.error.source': enumeration('deadline', 'provider', 'storage', 'unknown'),
  'optchat.operation.duration': number, 'optchat.sequence': number, 'optchat.model.attempt': number,
  'optchat.model.stop_reason': enumeration('pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'),
  'optchat.model.time_to_first_event': number, 'optchat.provider.id': named,
  'optchat.summary.build_attempt': number, 'optchat.memory.start_index': number, 'optchat.memory.message_count': number,
  'optchat.memory.pending': number, 'optchat.memory.in_flight': number, 'optchat.memory.generation.id': identifier,
  'optchat.memory.wait.mode': enumeration('turn', 'tree', 'ahead'), 'optchat.memory.wait.result': enumeration('ready', 'stalled', 'cancelled', 'error'),
  'optchat.retry.reason': enumeration('provider_error', 'output_limit', 'unexpected_tool', 'summary_too_large', 'storage_error', 'unknown'),
  'optchat.retry.delay': number, 'optchat.usage.availability': enumeration('reported', 'unknown'),
  'optchat.summary.fallback.reason': enumeration('model_refused'),
  'optchat.storage.operation': enumeration('memory_log', 'summary_node', 'memory_view', 'usage_ledger', 'run_metadata', 'recovery_journal', 'checkpoint', 'image', 'import'),
  'optchat.storage.bytes': number, 'optchat.records.count': number, 'optchat.messages.count': number,
  'optchat.agents.count': number, 'optchat.agent.depth': number, 'optchat.agent.connected': bool,
  'optchat.agent.state': enumeration('running', 'waiting', 'paused', 'stopping', 'stopped', 'completed', 'failed', 'interrupted'),
  'optchat.guidance.source': enumeration('user', 'manager'), 'optchat.guidance.state': enumeration('queued', 'delivered', 'undelivered'),
  'optchat.report.destination': enumeration('main', 'parent', 'memory', 'group'), 'optchat.report.delivered': bool,
  'optchat.window.action': enumeration('list-agents', 'attach', 'start', 'say', 'tell-main', 'answer', 'complete'),
  'optchat.window.attached': bool, 'optchat.window.cursor': number, 'optchat.window.connection.id': identifier,
  'optchat.window.close.reason': enumeration('complete', 'disconnected', 'owner-stopped', 'finished', 'deleted'),
  'optchat.import.mode': enumeration('append', 'rebuild'), 'optchat.import.id': identifier,
  'optchat.recovery.kind': enumeration('inputs', 'reports', 'handoff', 'agents', 'import'),
  'optchat.shutdown.reason': enumeration('quit', 'reload', 'new', 'resume', 'fork', 'profile', 'unknown'),
  'optchat.error.code': v => typeof v === 'string' && ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EROFS', 'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(v),
  'optchat.diagnostics.dropped_records': number, 'optchat.diagnostics.dropped_bytes': number,
};
for (const key of ['x-request-id', 'request-id', 'x-amzn-requestid']) fields[`http.response.header.${key}`] = v => Array.isArray(v) && v.length === 1 && identifier(v[0]);
const operations = new Set(['runtime', 'profile.open', 'profile.close', 'summary.attempt', 'cache.wait', 'inference', 'memory.wait', 'agent.spawn', 'agent.run', 'agent.turn', 'agent.resume', 'agent.stop', 'agent.delete', 'agent.report', 'handoff', 'tool', 'import', 'recovery', 'window.connect', 'window.request', 'window.replay', 'checkpoint']);
const events = new Set(['optchat.summary.retry.scheduled', 'optchat.model.retry.scheduled', 'optchat.summary.fallback', 'optchat.storage.failed', 'optchat.storage.completed', 'optchat.agent.state', 'optchat.guidance.queued', 'optchat.guidance.delivered', 'optchat.report.delivery', 'optchat.recovery.completed', 'optchat.window.closed', 'optchat.window.view.claimed', 'optchat.window.view.released', 'optchat.diagnostics.records_dropped', 'gen_ai.client.inference.operation.details']);
for (const operation of operations) { events.add(`optchat.${operation}.started`); events.add(`optchat.${operation}.completed`); }
const value = (v: string | number | boolean | readonly unknown[]): AnyValue => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } : { arrayValue: { values: v.map(x => value(x as string)) } };
/** Copy data descriptors only. Never execute extension/provider accessors during diagnostics. */
export function attributeData(...inputs: unknown[]): Attributes {
  const result = Object.create(null) as Attributes;
  for (const input of inputs) {
    try {
      if (!input || typeof input !== 'object') continue;
      for (const key of Object.keys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor) Object.defineProperty(result, key, 'value' in descriptor
          ? { value: descriptor.value, enumerable: true, configurable: true, writable: true }
          : { get: undefined, enumerable: true, configurable: true });
      }
    } catch { /* hostile proxies are diagnostic-only */ }
  }
  return result;
}
export const diagnosticData = (input: unknown, key: string): unknown => {
  try { return input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined; } catch { return undefined; }
};
const data = diagnosticData;
function safeArray(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const length = data(input, 'length');
  if (typeof length !== 'number' || length > 8) return undefined;
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) result.push(data(input, String(i)));
  return result;
}
function clean(input: Attributes): { attributes: KeyValue[]; dropped: number } {
  const attributes: KeyValue[] = []; let dropped = 0;
  try {
    for (const key of Object.keys(input)) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) { dropped++; continue; }
        if (descriptor.value === undefined) continue; // Missing optional metadata is not a discarded attribute.
        if (!Object.hasOwn(fields, key) || !fields[key](safeArray(descriptor.value)) || attributes.length >= 32) { dropped++; continue; }
        attributes.push({ key, value: value(safeArray(descriptor.value) as string | number | boolean | readonly unknown[]) });
      } catch { dropped++; }
    }
  } catch { dropped++; }
  return { attributes, dropped };
}
const unixNano = () => (BigInt(Date.now()) * 1_000_000n).toString();
const context = new AsyncLocalStorage<DiagnosticOperation>();
const domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get;
/** Classification is deliberately conservative. Free-form messages and stacks are never emitted. */
export function errorAttributes(error: unknown): Attributes {
  const attrs: Attributes = { 'error.type': 'unknown' };
  try {
    if (!error || typeof error !== 'object') return attrs;
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (fields['optchat.error.code'](code)) attrs['optchat.error.code'] = code;
    if (['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EROFS'].includes(code)) attrs['error.type'] = 'storage';
    if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) attrs['error.type'] = 'network';
    if (code === 'ETIMEDOUT') attrs['error.type'] = 'timeout';
    const status = Object.getOwnPropertyDescriptor(error, 'status')?.value;
    if (fields['http.response.status_code'](status)) attrs['http.response.status_code'] = status;
    if (status === 429) attrs['error.type'] = 'rate_limit';
    else if (status === 401 || status === 403) attrs['error.type'] = 'authentication';
    let errorName = data(error, 'name');
    // Node's AbortSignal.timeout() uses a branded DOMException with an inherited native accessor.
    // Call only that captured intrinsic, never the error object's potentially hostile getter.
    if (error instanceof DOMException && domExceptionName) errorName = domExceptionName.call(error);
    if (error instanceof Error && errorName === undefined) errorName = data(Object.getPrototypeOf(error), 'name');
    if (fields['exception.type'](errorName)) attrs['exception.type'] = errorName as string;
    if (errorName === 'TimeoutError') attrs['error.type'] = 'timeout';
  } catch { /* hostile error accessors must not escape diagnostics */ }
  return attrs;
}

/** A deadline is an error, not a user/shutdown cancellation. */
export const diagnosticCancelled = (signal?: AbortSignal): boolean => !!signal?.aborted && errorAttributes(signal.reason)['error.type'] !== 'timeout';

export function signalDiagnosticAttributes(signal?: AbortSignal): Attributes {
  if (!signal?.aborted) return {};
  return diagnosticCancelled(signal) ? { 'optchat.cancellation.reason': 'abort_signal' }
    : { 'error.type': 'timeout', 'optchat.error.source': 'deadline' };
}

const noopOperation: DiagnosticOperation = {
  traceId: '', spanId: '', run: fn => fn(), setAttributes() {}, addEvent() {}, setStatus() {}, end() {},
  async startSpan(_options, callback) { return callback(noopOperation); },
};
export interface DiagnosticOperation extends TelemetrySpan {
  traceId: string; spanId: string; run<T>(callback: () => T): T;
  end(outcome?: 'success' | 'error' | 'cancelled', attributes?: Attributes, error?: unknown): void;
}
export class Diagnostics implements TelemetryContext {
  readonly instanceId = randomUUID();
  readonly enabled: boolean;
  private readonly salt = randomBytes(32);
  private readonly identities = new WeakMap<DiagnosticOperation, Attributes>();
  private readonly resource: KeyValue[];
  private queue: { line: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private dropped = 0;
  private droppedBytes = 0;
  private totalDropped = 0;
  private warned = false;
  private failed = false;
  private closing = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private closePromise?: Promise<void>;
  private file?: FileHandle;
  private segment = 0;
  private fileBytes = 0;
  private readonly owned: string[] = [];
  private readonly settings: Required<Omit<DiagnosticOptions, 'warn' | 'version' | 'piVersion' | 'environment'>>;
  constructor(private readonly options: DiagnosticOptions, enabled = true) {
    this.enabled = enabled;
    const defaults = { maxFileBytes: 5 * 1024 * 1024, maxFiles: 3, maxDirectoryBytes: 50 * 1024 * 1024,
      retentionMs: 7 * 86400_000, maxQueueBytes: 1024 * 1024, maxQueueRecords: 1000, maxRecordBytes: 8192, flushMs: 200, shutdownMs: 1000 };
    const limits = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      const supplied = data(options, key);
      if (typeof supplied === 'number' && Number.isSafeInteger(supplied) && supplied > 0)
        limits[key] = Math.min(supplied, key === 'maxFiles' ? 100 : key === 'maxQueueRecords' ? 100_000 : 1_073_741_824);
    }
    this.settings = { ...limits, directory: resolve(options.directory) };
    const resource: Record<string, string | number> = { 'service.name': 'pi', 'service.instance.id': this.instanceId, 'process.pid': process.pid, 'process.runtime.name': 'nodejs', 'process.runtime.version': process.versions.node };
    if (options.piVersion && name(options.piVersion)) resource['service.version'] = options.piVersion;
    if (options.environment && ['development', 'test', 'production'].includes(options.environment)) resource['deployment.environment.name'] = options.environment;
    this.resource = Object.entries(resource).map(([key, v]) => ({ key, value: value(v) }));
  }
  opaque(kind: string, input: string) { return createHmac('sha256', this.salt).update(`${kind}\0${input}`).digest('hex').slice(0, 24); }
  correlation(operation: DiagnosticOperation | null | undefined = context.getStore()): Attributes {
    const stored = operation && this.identities.get(operation);
    const result: Attributes = {};
    for (const key of ['optchat.profile.id', 'optchat.session.id', 'optchat.turn.id', 'optchat.agent.id', 'optchat.parent.agent.id', 'optchat.memory.generation.id', 'optchat.summary.build_attempt', 'optchat.role']) {
      const entry = data(stored, key); if (entry !== undefined) result[key] = entry as string | number;
    }
    return result;
  }
  get stats() { return { queuedRecords: this.queue.length, queuedBytes: this.queuedBytes, droppedRecords: this.totalDropped, failed: this.failed }; }
  private warning() { if (this.warned) return; this.warned = true; try { this.options.warn?.(); } catch {} }
  private drop(bytes: number) { this.dropped++; this.totalDropped++; this.droppedBytes += bytes; this.warning(); }
  private batch(record: LogRecord): LogBatch {
    return { resourceLogs: [{ resource: { attributes: this.resource }, scopeLogs: [{ scope: { name: 'pi-optchat', version: this.options.version && name(this.options.version) ? this.options.version : undefined,
      attributes: [{ key: 'optchat.diagnostics.schema.version', value: { intValue: String(DIAGNOSTICS_SCHEMA_VERSION) } }, { key: 'optchat.semconv.gen_ai.revision', value: { stringValue: GENAI_REVISION } }] }, logRecords: [record] }] }] };
  }
  event(eventName: string, input: Attributes = {}, level: Level = 'DEBUG', operation = context.getStore()) {
    if (!this.enabled || this.closing || this.closed || this.failed || !events.has(eventName) || !Object.hasOwn(severities, level)) return;
    try {
      const observed = unixNano();
      const cleaned = clean(attributeData(this.correlation(operation), input, { 'optchat.sequence': ++this.sequence }));
      const record: LogRecord = { timeUnixNano: observed, observedTimeUnixNano: observed, severityNumber: severities[level], severityText: level, eventName,
        body: { stringValue: eventName }, attributes: cleaned.attributes };
      if (operation && /^[0-9a-f]{32}$/.test(operation.traceId) && /^[0-9a-f]{16}$/.test(operation.spanId)) { record.traceId = operation.traceId; record.spanId = operation.spanId; }
      if (cleaned.dropped) record.droppedAttributesCount = cleaned.dropped;
      const line = JSON.stringify(this.batch(record)) + '\n', bytes = Buffer.byteLength(line);
      if (bytes > this.settings.maxRecordBytes || this.queue.length >= this.settings.maxQueueRecords || this.queuedBytes + bytes > this.settings.maxQueueBytes) { this.drop(bytes); return; }
      this.queue.push({ line, bytes }); this.queuedBytes += bytes;
      if (!this.timer && !this.pumping) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.settings.flushMs); this.timer.unref(); }
    } catch { this.drop(0); }
  }
  begin(operationName: string, attributes: Attributes = {}, explicitParent?: DiagnosticOperation | null): DiagnosticOperation {
    if (!this.enabled || this.failed || this.closing || this.closed || !operations.has(operationName)) return noopOperation;
    const candidate = explicitParent === null ? undefined : explicitParent ?? context.getStore();
    const parent = candidate && this.identities.has(candidate) ? candidate : undefined;
    const traceId = parent?.traceId || randomBytes(16).toString('hex'), spanId = randomBytes(8).toString('hex');
    let attributesNow = attributeData(this.correlation(parent ?? null), attributes, parent?.spanId ? { 'optchat.parent.span_id': parent.spanId } : {});
    const started = performance.now(); let ended = false, status: SpanStatus | undefined;
    const owner = this;
    const span: DiagnosticOperation = {
      traceId, spanId,
      run: callback => context.run(span, callback),
      setAttributes(input) { if (!ended) { try { attributesNow = attributeData(attributesNow, input); owner.identities.set(span, attributesNow); } catch {} } },
      addEvent(eventName, input = {}) { if (!ended) owner.event(eventName, attributeData(attributesNow, input, { 'optchat.operation.phase': 'event' }), 'DEBUG', span); },
      setStatus(value) { if (!ended && (data(value, 'status') === 'error' || data(value, 'status') === 'ok')) status = { status: data(value, 'status') as 'error' | 'ok' }; },
      startSpan(options, callback) { return owner.startSpan(options, callback, span); },
      end(outcome = 'success', input = {}, error) {
        if (ended) return; ended = true;
        const result = status?.status === 'error' ? 'error' : outcome;
        owner.event(operationName === 'inference' ? 'gen_ai.client.inference.operation.details' : `optchat.${operationName}.completed`,
          attributeData(attributesNow, input, result === 'error' ? error === undefined && data(attributesNow, 'error.type') ? {} : errorAttributes(error) : {}, { 'optchat.operation.phase': 'end', 'optchat.operation.outcome': result, 'optchat.operation.duration': (performance.now() - started) / 1000 }),
          operationName === 'inference' ? 'DEBUG' : result === 'error' ? 'WARN' : 'DEBUG', span);
      },
    };
    this.identities.set(span, attributesNow);
    this.event(`optchat.${operationName}.started`, attributeData(attributesNow, { 'optchat.operation.phase': 'start' }), 'DEBUG', span);
    return span;
  }
  async startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>, parent?: DiagnosticOperation): Promise<T> {
    const execute = async () => {
      const spanName = data(options, 'name');
      const operation = this.begin(typeof spanName === 'string' ? spanName.replace(/^optchat\./, '') : '', attributeData(data(options, 'attributes')));
      try { const result = await operation.run(() => callback(operation)); operation.end(); return result; }
      catch (error) { operation.end('error', {}, error); throw error; }
    };
    return parent ? parent.run(execute) : execute();
  }
  private async files() {
    const result: { path: string; bytes: number; modified: number; alive: boolean }[] = [];
    for (const entry of await readdir(this.settings.directory)) {
      const match = /^(\d+)-[0-9a-f-]{36}-\d{4,}\.jsonl$/.exec(entry); if (!match) continue;
      const path = join(this.settings.directory, entry), stat = await lstat(path).catch(() => undefined);
      if (!stat?.isFile()) continue;
      let alive = true; try { process.kill(Number(match[1]), 0); } catch (error) { alive = !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
      result.push({ path, bytes: stat.size, modified: stat.mtimeMs, alive });
    }
    return result.sort((a, b) => a.modified - b.modified);
  }
  private async prepare() {
    const directory = this.settings.directory;
    // Check the nearest existing ancestor before mkdir: an unsafe destination must not pollute profiles.
    if (directory.split(/[\\/]/).includes('profiles')) throw new Error('Unsafe diagnostic destination');
    let ancestor = directory;
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
    if ((await realpath(ancestor)).split(/[\\/]/).includes('profiles')) throw new Error('Unsafe diagnostic destination');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Unsafe diagnostic destination');
    for (const entry of await this.files()) if (!entry.alive && Date.now() - entry.modified > this.settings.retentionMs) await unlink(entry.path).catch(() => {});
  }
  private async rotate(bytes: number) {
    if (this.file && this.fileBytes + bytes <= this.settings.maxFileBytes) return;
    await this.file?.close(); this.file = undefined;
    const path = join(this.settings.directory, `${process.pid}-${this.instanceId}-${String(this.segment++).padStart(4, '0')}.jsonl`);
    this.file = await open(path, 'ax', 0o600); this.fileBytes = 0; this.owned.push(path);
    while (this.owned.length > this.settings.maxFiles) await unlink(this.owned.shift()!).catch(() => {});
  }
  async flush(): Promise<void> {
    if (!this.enabled || this.closed || this.failed) return;
    clearTimeout(this.timer); this.timer = undefined;
    if (this.pumping) return this.pumping;
    const pump = async () => {
      let active: { line: string; bytes: number }[] = [];
      let notified = false;
      try {
        await this.prepare();
        while (this.queue.length && !this.closed) {
          // Split on file budget: records that fit individually must not be dropped as a large batch.
          let bytes = 0;
          while (this.queue.length && active.length < 32) {
            const next = this.queue[0];
            if (next.bytes > this.settings.maxFileBytes || next.bytes > this.settings.maxDirectoryBytes) {
              this.queue.shift(); this.queuedBytes -= next.bytes; this.drop(next.bytes); continue;
            }
            if (bytes + next.bytes > this.settings.maxFileBytes) break;
            active.push(this.queue.shift()!); this.queuedBytes -= next.bytes; bytes += next.bytes;
          }
          if (!active.length) continue;
          const files = await this.files();
          const rotating = !this.file || this.fileBytes + bytes > this.settings.maxFileBytes;
          const retire = rotating ? this.owned.slice(0, Math.max(0, this.owned.length + 1 - this.settings.maxFiles)) : [];
          let total = files.filter(f => !retire.includes(f.path)).reduce((sum, f) => sum + f.bytes, 0);
          for (const entry of files) if (total + bytes > this.settings.maxDirectoryBytes && !entry.alive) { await unlink(entry.path); total -= entry.bytes; }
          // Conservative soft budget across processes: never delete another live writer's files.
          if (total + bytes > this.settings.maxDirectoryBytes) { for (const entry of active) this.drop(entry.bytes); active = []; continue; }
          if (this.closed) { for (const entry of active) this.drop(entry.bytes); active = []; break; }
          await this.rotate(bytes);
          if (this.closed) { for (const entry of active) this.drop(entry.bytes); active = []; break; }
          await this.file!.writeFile(active.map(e => e.line).join('')); this.fileBytes += bytes; active = [];
          if (this.dropped && !notified && !this.closing) {
            notified = true;
            const count = this.dropped, droppedBytes = this.droppedBytes; this.dropped = 0; this.droppedBytes = 0;
            this.event('optchat.diagnostics.records_dropped', { 'optchat.diagnostics.dropped_records': count, 'optchat.diagnostics.dropped_bytes': droppedBytes }, 'WARN');
          }
        }
      } catch {
        this.failed = true;
        // Include the drained batch: append/rotate may have failed after removal from the queue.
        for (const entry of [...active, ...this.queue]) this.drop(entry.bytes);
        this.queue = []; this.queuedBytes = 0; this.warning();
      }
    };
    this.pumping = pump().finally(() => { this.pumping = undefined; }); return this.pumping;
  }
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeOnce();
    return this.closePromise;
  }
  private async closeOnce() {
    if (this.closed) return;
    this.closing = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.flush(), new Promise<void>(resolve => { timeout = setTimeout(resolve, this.settings.shutdownMs); })]);
    clearTimeout(timeout); clearTimeout(this.timer); this.closed = true;
    for (const entry of this.queue) this.drop(entry.bytes); this.queue = []; this.queuedBytes = 0;
    // Do not wait forever for a stalled disk; close the descriptor after the pending append settles.
    if (this.pumping) void this.pumping.finally(() => this.file?.close()).catch(() => {}); else await this.file?.close().catch(() => {});
  }
}
const disabled = new Diagnostics({ directory: '.' }, false);
let current = disabled;
export const diagnostics = () => current;
export function startDiagnostics(version?: string, warn?: () => void): Diagnostics {
  if (current.enabled) return current;
  if (!['1', 'true', 'yes'].includes(process.env.OPTCHAT_DIAGNOSTICS ?? '')) return disabled;
  let piVersion: string | undefined;
  let executable = resolve(process.argv[1] ?? '.');
  try { executable = realpathSync(executable); } catch {}
  for (let directory = dirname(executable); directory !== dirname(directory); directory = dirname(directory)) {
    const file = join(directory, 'package.json');
    try { if (existsSync(file)) { const data = JSON.parse(readFileSync(file, 'utf8')); if (data.name === '@earendil-works/pi-coding-agent') { piVersion = data.version; break; } } } catch {}
  }
  const home = resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
  current = new Diagnostics({ directory: join(home, 'diagnostics'), version, piVersion, warn,
    environment: process.env.OPTCHAT_DEV === '1' ? 'development' : undefined });
  current.event('optchat.runtime.started', {}, 'INFO'); return current;
}
export async function stopDiagnostics(reason = 'unknown') {
  const old = current;
  old.event('optchat.runtime.completed', { 'optchat.shutdown.reason': reason }, 'INFO');
  current = disabled; await old.close();
}
export function storageEvent<T>(operation: string, work: () => T, identity: Attributes = {}): T {
  if (!current.enabled) return work();
  const owner = current, start = performance.now();
  const done = () => owner.event('optchat.storage.completed', attributeData(identity, { 'optchat.storage.operation': operation, 'optchat.operation.duration': (performance.now() - start) / 1000 }));
  const failed = (error: unknown) => owner.event('optchat.storage.failed', attributeData(identity, { 'optchat.storage.operation': operation }, errorAttributes(error), { 'optchat.error.source': 'storage' }), 'ERROR');
  try {
    const result = work();
    if (result instanceof Promise) return result.then(value => { done(); return value; }, error => { failed(error); throw error; }) as T;
    done(); return result;
  } catch (error) { failed(error); throw error; }
}
