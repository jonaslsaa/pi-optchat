import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { reasoningFor, retryTransient, type ModelChoice } from './compactor.ts';
import { HANDOFF } from './prompts.ts';
import { undelivered, type RunInfo } from './runs.ts';
import { textContent } from './transcript.ts';

export interface HandoffEvidence { run: RunInfo; messages: AgentMessage[]; transcriptError?: string }

const INPUT_TOKENS = 128_000;
const OUTPUT_TOKENS = 16_000;

function formatEvidence({ run, messages, transcriptError }: HandoffEvidence) {
  let firstUser = true;
  const transcript = `AGENT ${run.id} · parent ${run.parentId ?? 'main'} · ${run.state}\nWorking directory: ${run.cwd}\n${run.connected ? 'USER REQUEST' : 'DELEGATED TASK'}: ${run.task}\nTranscript: ${run.sessionFile ?? 'not created'}${transcriptError ? `\nTranscript read failed: ${transcriptError}` : ''}\n\n` + messages.flatMap(message => {
    if (message.role === 'user') {
      const text = textContent(message.content);
      if (firstUser) { firstUser = false; return []; }
      return [text.startsWith('[Main agent guidance]') ? `MAIN AGENT: ${text}` : `${run.connected ? 'USER' : 'DELEGATED INPUT'}: ${text}`];
    }
    if (message.role === 'assistant') return message.content.flatMap(block => block.type === 'text' ? [`ASSISTANT: ${block.text}`]
      : block.type === 'toolCall' ? [`TOOL CALL: ${block.name} ${JSON.stringify(block.arguments)}`] : []);
    if (message.role === 'toolResult') return [`TOOL RESULT (${message.toolName}, error=${message.isError}): ${textContent(message.content)}`];
    return [];
  }).join('\n\n') + `\n\nRecorded outcome before handoff: ${run.report ?? 'No final answer'}`;
  const queued = undelivered(run);
  return transcript + (queued.length ? `\nMessages queued but NOT delivered to this agent:\n${queued.join('\n')}` : '');
}

/** Summarize in one call when possible; otherwise fold chunks with the prior handoff included in the budget. */
export function createHandoffSummarizer(registry: ModelRegistry, choice: () => ModelChoice,
  usage: (message: AssistantMessage) => void, retryDelays?: readonly number[]) {
  return async (run: RunInfo, messages: AgentMessage[], descendants: HandoffEvidence[] = [], signal?: AbortSignal) => {
    const selected = choice(), model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error('Profile compactor model unavailable');
    const transcript = Buffer.from([{ run, messages }, ...descendants].map(formatEvidence).join('\n\n'));
    const maxTokens = Math.min(OUTPUT_TOKENS, model.maxTokens, Math.floor(model.contextWindow / 4));
    // Estimate four UTF-8 bytes per token, reserving 20% of the window for estimation
    // error plus the output budget. This is a heuristic, not a provider token count.
    const inputTokens = Math.min(INPUT_TOKENS, Math.floor(model.contextWindow * 0.8) - maxTokens);
    if (inputTokens < 2000) throw new Error('Compactor context window too small for a handoff');
    // Account for message framing as well as the actual system/user text below.
    const inputBytes = (inputTokens - 256) * 4;
    let summary = '';
    for (let offset = 0; offset < transcript.length;) {
      const prefix = `Ending: ${run.handoff?.reason}\nWorking directory: ${run.cwd}\nPrior handoff:\n${summary}\nNext transcript chunk:\n`;
      const available = inputBytes - Buffer.byteLength(HANDOFF) - Buffer.byteLength(prefix);
      if (available < 4) throw new Error('Handoff instructions and prior summary leave no room for transcript evidence');
      let end = Math.min(transcript.length, offset + available);
      // Keep multibyte characters intact at chunk boundaries.
      while (end < transcript.length && (transcript[end] & 0xc0) === 0x80) end--;
      const reply = await retryTransient(() => registry.streamSimple(model, {
        systemPrompt: HANDOFF,
        messages: [{ role: 'user', timestamp: Date.now(), content: prefix + transcript.subarray(offset, end).toString('utf8') }],
      }, { reasoning: reasoningFor(model, selected.thinking), maxTokens, signal: AbortSignal.any([AbortSignal.timeout(300_000), ...signal ? [signal] : []]) }).result(), usage, retryDelays, signal);
      summary = handoffText(reply);
      offset = end;
    }
    return withUndelivered(run, summary);
  };
}

/** A handoff reply's text; a failed, cut-off, empty or tool-calling reply throws. */
export function handoffText(reply: AssistantMessage) {
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? reply.stopReason);
  if (reply.stopReason === 'length') throw new Error('Handoff hit the model output limit before finishing');
  // A reply that calls a tool isn't finished: its text is a preamble, not the handoff.
  if (reply.content.some(block => block.type === 'toolCall')) throw new Error('The handoff reply ended on a tool call');
  const text = textContent(reply.content).trim();
  if (!text) throw new Error('Empty handoff summary');
  return text;
}
export const withUndelivered = (run: RunInfo, summary: string) => {
  const queued = undelivered(run);
  return summary + (queued.length ? `\nMessages queued but NOT delivered to the agent:\n${queued.join('\n')}` : '');
};
