import type { AssistantMessage, Model, Api } from '@earendil-works/pi-ai';
import { performance } from 'node:perf_hooks';
import { diagnostics, attributeData, diagnosticData as data, type Attributes, type DiagnosticOperation } from './diagnostics.ts';

/** Own one logical model request through response consumption; never inspect prompts or stream payloads. */
export function modelDiagnostics(model: Pick<Model<Api>, 'provider' | 'id'>, attributes: Attributes = {}, parent?: DiagnosticOperation) {
  const started = performance.now(); let first = false, ended = false;
  const provider = data(model, 'provider');
  const span = diagnostics().begin('inference', attributeData({
    'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider === 'openai-codex' ? 'openai' : provider,
    'optchat.provider.id': provider, 'gen_ai.request.model': data(model, 'id'), 'gen_ai.request.stream': true,
  }, attributes), parent);
  return {
    span,
    options: {
      telemetryContext: span,
      onResponse(response: { status: number; headers: Record<string, string> }) {
        const headers = attributeData({ 'http.response.status_code': data(response, 'status') });
        for (const key of ['x-request-id', 'request-id', 'x-amzn-requestid']) {
          const entry = data(data(response, 'headers'), key);
          if (typeof entry === 'string') headers[`http.response.header.${key}`] = [entry];
        }
        span.setAttributes(headers);
      },
    },
    observe(type: string) {
      if (!first && type !== 'start') { first = true; span.setAttributes({ 'optchat.model.time_to_first_event': (performance.now() - started) / 1000 }); }
    },
    finish(reply?: AssistantMessage, cancelled = false, error?: unknown, finishAttributes: Attributes = {}) {
      if (ended) return; ended = true;
      const stopReason = data(reply, 'stopReason');
      if (reply) {
        const usage = data(reply, 'usage');
        const counts = ['input', 'output', 'cacheRead', 'cacheWrite'].map(key => data(usage, key));
        const valid = counts.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
        const known = valid && counts.some(n => typeof n === 'number' && n > 0);
        const [input, output, read, write] = counts as number[];
        span.setAttributes(attributeData({
          'gen_ai.response.id': data(reply, 'responseId'), 'gen_ai.response.model': data(reply, 'responseModel'),
          'gen_ai.response.finish_reasons': [data(reply, 'rawStopReason') ?? stopReason], 'optchat.model.stop_reason': stopReason,
          'optchat.usage.availability': known ? 'reported' : 'unknown',
        }, known ? {
          'gen_ai.usage.input_tokens': input + read + write, 'gen_ai.usage.output_tokens': output,
          'gen_ai.usage.cache_read.input_tokens': read, 'gen_ai.usage.cache_write.input_tokens': write,
          'gen_ai.usage.reasoning.output_tokens': data(usage, 'reasoning'),
        } : {}));
      }
      const interrupted = cancelled || stopReason === 'aborted' && error === undefined && data(finishAttributes, 'optchat.error.source') !== 'deadline';
      const outcome = interrupted ? 'cancelled' : error !== undefined || stopReason === 'error' || stopReason === 'aborted' ? 'error' : 'success';
      span.end(outcome, attributeData(interrupted ? { 'optchat.cancellation.reason': 'unknown' } : outcome === 'error' ? { 'optchat.error.source': 'provider' } : {}, finishAttributes), error);
    },
  };
}
export type ModelDiagnostics = ReturnType<typeof modelDiagnostics>;
