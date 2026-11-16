import { clampThinkingLevel, isRetryableAssistantError, type Api, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createCompressor as compressor, type CompressorOptions } from './core/compactor.ts';
import { noteLimits, noteRefusal } from './limits.ts';
import type { ModelChoice } from './profiles.ts';

/** A level the model can't take would be sent as no level, which Sonnet 5.5 runs at high effort; Pi's own sessions clamp the same way. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = clampThinkingLevel(model, level);
  return thinking === 'off' ? undefined : thinking;
};

/** The profile's compactor: `choice` is read for each call, through Pi's registry and its keys. `accepted` is the profile's
 * summary size tolerance. `limits` is the profile's folder where its answers keep the subscription's limits (limits.ts): the
 * headers of each, and the refusal one ends in. */
export const createCompressor = (registry: ModelRegistry, choice: () => ModelChoice,
  { limits, ...options }: Omit<CompressorOptions, 'model' | 'retryable' | 'onHeaders'> & { limits?: string } = {}) => compressor({ ...options, retryable: isRetryableAssistantError,
  ...limits && { onHeaders: headers => noteLimits(limits, headers), onUsage: reply => { options.onUsage?.(reply); noteRefusal(limits, reply.errorMessage); } },
  model: () => {
    const selected = choice(), model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    return { model, reasoning: reasoningFor(model, selected.thinking), stream: (model, context, options) => registry.streamSimple(model, context, options) };
  } });
