// Explicit opt-in: real Claude Code calls, synthetic data and disposable OptChat/Pi state.
// This checks functionality, NOT billing attribution. Disable paid Extra Usage before running.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.OPTCHAT_BRIDGE_LIVE !== '1') throw new Error('Real subscription calls require OPTCHAT_BRIDGE_LIVE=1. Check Claude billing/Extra Usage first.');
const { assertSubscriptionEnvironment } = await import('../src/claude-bridge.ts');
assertSubscriptionEnvironment();
const root = mkdtempSync(join(tmpdir(), 'optchat-bridge-live-'));
process.env.OPTCHAT_HOME = join(root, 'optchat');
process.env.PI_CODING_AGENT_DIR = join(root, 'pi');
process.env.OPTCHAT_CLAUDE_BRIDGE = '1';
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(root, 'bridge.log');
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const project = join(root, 'project'); mkdirSync(project);
process.chdir(project);
writeFileSync(join(project, 'AGENTS.md'), 'This is a synthetic test. Do not edit files or access the network.');
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'claude-bridge.json'), JSON.stringify({ startupNoticeShown: 'test', askClaude: { enabled: false }, provider: { plan: 'pro', longContextExtraUsage: false } }));
console.log('Disposable fixture:', root);

const { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
const { default: optchat } = await import('../src/index.ts');
const { createProfile, profilePath, saveConfig } = await import('../src/profiles.ts');
const { createCompressor } = await import('../src/compactor.ts');
const { createHandoffSummarizer } = await import('../src/handoff.ts');
const { Children } = await import('../src/agents.ts');
const { Memory } = await import('../src/memory.ts');
const { textContent } = await import('../src/transcript.ts');
const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: project, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const id = process.env.OPTCHAT_BRIDGE_TEST_MODEL ?? 'claude-haiku-4-5';
const choice = { provider: 'claude-bridge', model: id, thinking: 'off' as const };
createProfile('fixture');
saveConfig(profilePath('fixture'), { compactor: choice, subagent: choice });
writeFileSync(join(profilePath('fixture'), 'AGENTS.md'), 'Synthetic marker BRIDGE_PROFILE_RULE_814. When asked for the profile marker, repeat it exactly.');
const manager = SessionManager.inMemory(); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
const { session } = await createAgentSession({ cwd: project, modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, settingsManager, tools: ['zoom', 'date', 'spawn', 'tell'], thinkingLevel: 'off' });
const registry = new ModelRegistry(runtime), model = registry.find(choice.provider, choice.model);
assert.ok(model); await session.setModel(model);
const memory = new Memory(join(root, 'children-memory'), async input => input.source.slice(0, 100), () => {});
memory.append('user', 'Synthetic phrase beige heron 814.');
const reports: string[] = [], warnings: string[] = [];
const children = new Children(memory, registry, () => choice, () => 'Synthetic test: no filesystem changes or network tools.', async text => { reports.push(text); }, text => warnings.push(text), join(root, 'children'), {
  createSession: options => createAgentSession({ ...options, modelRuntime: runtime }), summarizeHandoff: createHandoffSummarizer(registry, () => choice, () => {}),
});
const deadline = new AbortController();
const timer = setTimeout(() => { deadline.abort(); session.abort(); void children.close(); }, 180000);
async function waitFor(predicate: () => boolean) {
  while (!predicate()) { deadline.signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function checkReply(label: string) {
  const last = session.messages.findLast(m => m.role === 'assistant');
  assert.ok(last && last.role === 'assistant' && last.stopReason !== 'error' && last.stopReason !== 'aborted', `${label}: ${last && 'errorMessage' in last ? last.errorMessage : 'No successful reply'}`);
  console.log(label + ':', session.getLastAssistantText());
}
try {
  await session.bindExtensions({});
  await session.prompt('Remember synthetic phrase beige heron 814. Reply ACK and the profile marker from your instructions.');
  checkReply('MAIN'); assert.match(session.getLastAssistantText() ?? '', /BRIDGE_PROFILE_RULE_814/);
  await session.prompt('Use zoom to retrieve memory message 0, then reply with the exact synthetic phrase.');
  checkReply('ZOOM'); assert.match(session.getLastAssistantText() ?? '', /beige heron 814/);
  assert.ok(session.messages.some(m => m.role === 'toolResult' && m.toolName === 'zoom'));
  let mainWoke = false;
  const unsubscribe = session.subscribe(event => {
    if (event.type !== 'agent_settled') return;
    const reportIndex = session.messages.findLastIndex(m => m.role === 'custom' && m.customType === 'optchat-report' && textContent(m.content).includes('MAIN_CHILD_WAKE_814'));
    if (reportIndex >= 0 && session.messages.slice(reportIndex + 1).some(m => m.role === 'assistant')) mainWoke = true;
  });
  try {
    await session.prompt('Use spawn to start exactly one child whose only task is: "Reply MAIN_CHILD_WAKE_814. Do not use tools." Return after spawn, do not poll or sleep. When the automatic child report arrives, acknowledge it.');
    await waitFor(() => mainWoke);
    checkReply('AUTOMATIC MAIN WAKE');
    console.log('MAIN SPAWN + CUSTOM REPORT + IDLE WAKE: PASS');
  } finally { unsubscribe(); }
  const summary = await createCompressor(registry, () => choice)({ source: 'User decided synthetic phrase beige heron 814.', context: '', merge: false }, deadline.signal);
  assert.match(summary, /814/); console.log('COMPACTOR:', summary);
  const [id] = await children.spawn([{ task: 'Use zoom to read memory message 0. Use tell_parent once with the synthetic phrase you found. Then reply DONE. Do not spawn other agents.' }], project, deadline.signal);
  await waitFor(() => !children.active);
  assert.equal(children.history.records.get(id)?.state, 'completed');
  assert.ok(children.messages(id).some(m => m.role === 'toolResult' && m.toolName === 'tell_parent'));
  assert.ok(reports.some(text => /beige heron 814/.test(text)));
  console.log('CHILD + TELL_PARENT: PASS');
  const siblings = await children.spawn([
    { task: 'Use zoom to read memory message 0, then reply SIBLING_A plus the exact synthetic phrase. Do not spawn agents.' },
    { task: 'Reply SIBLING_B. Do not use tools or spawn agents.' },
  ], project, deadline.signal);
  // A third main turn runs while both child sessions are alive in the same process.
  await session.prompt('Use zoom to retrieve memory message 0 again. Reply the synthetic phrase and the profile marker.');
  checkReply('CONCURRENT MAIN'); assert.match(session.getLastAssistantText() ?? '', /BRIDGE_PROFILE_RULE_814/);
  await waitFor(() => !children.active);
  for (const id of siblings) assert.equal(children.history.records.get(id)?.state, 'completed');
  assert.ok(reports.some(text => /SIBLING_A/.test(text)));
  assert.ok(reports.some(text => /SIBLING_B/.test(text)));
  console.log('CONCURRENT MAIN + TWO CHILDREN: PASS');
  const [parent] = await children.spawn([{ task: 'Use spawn exactly once to delegate this task: "Use tell_parent to send NESTED_CHILD_814, then reply NESTED_DONE. Do not spawn further agents." Return after spawning; the harness will deliver the child report automatically. When it arrives, reply NESTED_PARENT_DONE. Do not poll or sleep.' }], project, deadline.signal);
  await waitFor(() => !children.active);
  assert.equal(children.history.records.get(parent)?.state, 'completed');
  const nested = [...children.history.records.values()].find(run => run.parentId === parent);
  assert.ok(nested, 'nested delegation was not exercised');
  assert.equal(nested.state, 'completed');
  assert.ok(children.messages(nested.id).some(m => m.role === 'toolResult' && m.toolName === 'tell_parent'));
  assert.ok(children.messages(parent).some(m => m.role === 'user' && textContent(m.content).includes('NESTED_CHILD_814')));
  console.log('NESTED SPAWN + TELL_PARENT: PASS');
  const [connected] = await children.spawn([{ task: 'Reply CONNECTED_ACK. Do not use tools.' }], project, deadline.signal, undefined, true);
  await waitFor(() => children.history.records.get(connected)?.state === 'waiting');
  assert.match(children.live(connected)?.session.getLastAssistantText() ?? '', /CONNECTED_ACK/);
  await children.finish(connected, 'complete');
  await waitFor(() => !children.active);
  assert.ok(reports.some(text => /CONNECTED_ACK/.test(text)));
  console.log('CONNECTED HANDOFF: PASS');
  assert.deepEqual(warnings, []);
  console.log('PASS: main instructions, memory/zoom, isolated compactor, automatic parent wake, concurrent/nested agents and connected handoff. Billing bucket NOT verified.');
} finally {
  clearTimeout(timer); deadline.abort();
  await children.close(); await memory.close();
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
  console.log('Fixture retained for inspection:', root);
}
