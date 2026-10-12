import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Memory, PAGE, CAP } from '../src/memory.ts';
import { memoryTools, runPage } from '../src/tools.ts';
import { runTranscript } from '../src/transcript.ts';
import { reportParts } from '../src/report-message.ts';
import { removeDir } from './support.ts';

const at = { timestamp: 0 };
const assistant = (content: Extract<AgentMessage, { role: 'assistant' }>['content']): AgentMessage => ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'p', model: 'm',
  stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...at });
const chat: AgentMessage[] = [
  { role: 'user', content: '<chat>\n0+1|a long memory view\n</chat>\n\nYour task:\nRun the tests.', ...at },
  assistant([{ type: 'text', text: 'Running them.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'npm test' } }]),
  { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok '.repeat(2_000) + 'fail 1' }], isError: false, ...at },
  { role: 'user', content: 'Parent says: fix it.', ...at },
  { role: 'user', content: '<chat>\npasted by the parent', ...at },
];

test('a run transcript keeps retained tool evidence whole and strips only the initial memory view', () => {
  const text = runTranscript(chat);
  assert.ok(text.startsWith('user|Your task:\nRun the tests.\ntalk|Running them.\ntool|bash {"command":"npm test"}\necho|bash: ok ok'));
  assert.ok(!text.includes('a long memory view'));
  assert.ok(text.includes('echo|bash: ' + 'ok '.repeat(2_000) + 'fail 1'));
  assert.match(text, /fail 1\nuser\|Parent says: fix it\.\nuser\|<chat>\npasted by the parent$/, 'only the task prompt loses its memory view');
  assert.doesNotMatch(text, /characters omitted/);
  const withNotice = runTranscript([{ role: 'custom', customType: 'notice', content: 'Shown before task', display: true, ...at }, ...chat]);
  assert.ok(withNotice.startsWith('user|[notice] Shown before task\nuser|Your task:'));
  assert.ok(!withNotice.includes('a long memory view'));
});

test('all pages reconstruct long arguments and results exactly, preserving Unicode and excluding thoughts and images', () => {
  const args = 'a'.repeat(PAGE - 25) + '😀ARGUMENT_MIDDLE' + '字'.repeat(35_000), output = 'echo '.repeat(8000) + 'RESULT_MIDDLE😀' + 'tail'.repeat(9000);
  const messages: AgentMessage[] = [
    assistant([{ type: 'thinking', thinking: 'PRIVATE_THOUGHTS' }, { type: 'toolCall', id: 't', name: 'read', arguments: { source: args } }]),
    { role: 'toolResult', toolCallId: 't', toolName: 'read', isError: false, content: [{ type: 'text', text: output }, { type: 'image', data: 'PRIVATE_IMAGE_DATA', mimeType: 'image/png' }], ...at },
  ];
  const source = runTranscript(messages);
  assert.equal(source, `tool|read ${JSON.stringify({ source: args })}\necho|read: ${output}`);
  let reconstructed = '', offset = 0;
  while (offset < source.length) {
    const page = runPage(source, offset, 1_000_000);
    assert.ok(page.length <= CAP);
    assert.ok(page.isWellFormed());
    const match = /^([\s\S]*)\n\[characters (\d+)-(\d+) of (\d+)(?:; go on with offset (\d+))?\]$/.exec(page)!;
    assert.equal(Number(match[2]), offset);
    reconstructed += match[1]; offset = Number(match[3]);
    assert.equal(match[5] === undefined, offset === source.length);
  }
  assert.equal(reconstructed, source);
  assert.match(reconstructed, /ARGUMENT_MIDDLE/); assert.match(reconstructed, /RESULT_MIDDLE/);
  assert.doesNotMatch(reconstructed, /PRIVATE_/);
  assert.equal(runPage('😀a', 0, 1), '😀\n[characters 0-2 of 3; go on with offset 2]');
  assert.throws(() => runPage(source, -1), /offset/);
  assert.throws(() => runPage(source, 0, 0), /limit/);
});

test('zoom takes a run id: the transcript in pages that say where to go on; an unknown run says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-runs-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const long = [...chat, ...Array.from({ length: 300 }, (_, i) => assistant([{ type: 'text', text: `step ${i} `.repeat(30) }]))];
  const runs = (id: string) => id === 'abcd1234' ? chat : id === 'feed0000' ? long : id === '12345678' ? [] : undefined;
  const zoom = memoryTools(() => memory, runs)[0];
  const text = async (args: Parameters<typeof zoom.execute>[1]) => (await zoom.execute('call', args)).content.flatMap(c => c.type === 'text' ? [c.text] : []).join('');
  try {
    memory.append('user', 'hello');
    const whole = runTranscript(chat);
    assert.equal(await text({ id: 'abcd1234' }), `${whole}\n[characters 0-${whole.length} of ${whole.length}]`);
    const all = runTranscript(long), first = await text({ id: 'feed0000' });
    assert.equal(first, `${all.slice(0, PAGE)}\n[characters 0-${PAGE} of ${all.length}; go on with offset ${PAGE}]`);
    assert.equal(await text({ id: 'feed0000', offset: PAGE, limit: 10 }), `${all.slice(PAGE, PAGE + 10)}\n[characters ${PAGE}-${PAGE + 10} of ${all.length}; go on with offset ${PAGE + 10}]`);
    assert.equal(await text({ id: '12345678' }), '\n[characters 0-0 of 0]', 'an all-digit run id is a run, even before it has said anything');
    await assert.rejects(zoom.execute('call', { id: 'gone0000' }), /^Error: No run gone0000\.$/);
    await assert.rejects(zoom.execute('call', { id: '87654321' }), /^Error: No run 87654321\.$/, 'eight digits is a run id, even one that is gone');
    assert.equal(await text({ id: '0', n: 1 }), '0+1|user: hello', 'a message id sent as a string still opens the message');
    assert.equal(await text({ id: 0 }), '0+1|user: hello', 'n defaults to 1');
  } finally { await memory.close(); removeDir(dir); }
});

test('the report box leaves out the Full chat trailer', () => {
  assert.equal(reportParts('[abcd1234] Done.\n\nFull chat: zoom("abcd1234")').body, 'Done.');
  assert.equal(reportParts('[abcd1234] A.\n\nFull chat: zoom("abcd1234")\n\n[feed0000] B.\n\nFull chat: zoom("feed0000")', 2).body, '[abcd1234] A.\n\n[feed0000] B.');
});
