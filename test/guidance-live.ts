// Explicit opt-in: real provider requests with synthetic instructions and no private project/profile context.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelRuntime, convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Guidance, type GuidanceState } from '../src/guidance.ts';
import { textContent } from '../src/transcript.ts';
import { cachePayload } from '../src/cache.ts';

const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const provider = process.env.OPTCHAT_GUIDANCE_PROVIDER ?? 'openai';
const modelId = process.env.OPTCHAT_GUIDANCE_MODEL ?? 'gpt-6.1-sol';
const model = (await runtime.getAvailable(provider)).find(model => model.id === modelId);
assert.ok(model, `No usable login/model for ${provider}/${modelId}. Log in with Pi or set OPTCHAT_GUIDANCE_PROVIDER and OPTCHAT_GUIDANCE_MODEL; no live requests were sent.`);
const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-live-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
mkdirSync(cwd); mkdirSync(profile);
const file = join(profile, 'AGENTS.md'), guidance = new Guidance(profile, { discover: false });
const background = Array.from({ length: 500 }, (_, i) => `Synthetic project convention ${i}: keep deliberate architecture choices consistent with the current guidance.`).join('\n');
const set = (database: string) => writeFileSync(file, `The required project database is ${database}.\n${background}`);
let state: GuidanceState | undefined;
const rows: { phase: string; answer: string; input: number; cacheRead: number; cacheWrite: number; promptHash: string }[] = [];
const messages: AgentMessage[] = [{ role: 'system', content: 'Follow the current project guidance. This is a synthetic validation; answer only the requested short answer.', timestamp: 0 }];
try {
  for (const [index, phase] of ['initial', 'unchanged', 'edited', 'unchanged-after-edit'].entries()) {
    if (index === 0) set('SQLite');
    if (index === 2) set('PostgreSQL');
    messages.push({ role: 'user', content: `<chat>\n${index}+1|Synthetic progress.\n</chat>\n\n${index < 2 ? 'Which database is required now? Reply with its name only.' : 'Which database is required now, and does earlier SQLite work necessarily imply an instruction violation? Reply: database; yes/no.'}`, timestamp: index + 1 });
    const prepared = guidance.prepare(messages, cwd, state, next => { state = next; });
    const head = prepared.messages[0]; assert.equal(head.role, 'system');
    const promptHash = createHash('sha256').update(textContent(head.content)).digest('hex');
    const reply = await runtime.streamSimple(model, { messages: convertToLlm(prepared.messages) }, {
      maxTokens: 512, sessionId: `guidance-validation-${dir}`,
      onPayload: payload => model.api === 'anthropic-messages' ? cachePayload(payload) : payload,
    }).result();
    assert.notEqual(reply.stopReason, 'error', reply.errorMessage);
    const answer = textContent(reply.content);
    rows.push({ phase, answer, input: reply.usage.input, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite, promptHash });
    console.log(JSON.stringify(rows.at(-1)));
    assert.match(answer, index < 2 ? /SQLite/i : /PostgreSQL.*no/i);
    messages.push(reply);
  }
  assert.equal(rows[0].promptHash, rows[1].promptHash);
  assert.notEqual(rows[1].promptHash, rows[2].promptHash);
  assert.equal(rows[2].promptHash, rows[3].promptHash);
  console.log('PASS: current guidance and transition interpretation. Cache counters above are observations, not guaranteed savings.');
} finally { rmSync(dir, { recursive: true, force: true }); }
