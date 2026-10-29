// Runs the example under `wrangler dev` (local workerd) with real model calls and checks what OptChat on Pi Durable must do:
// a multi-turn chat with tool calls built from the view, a restart that rebuilds nothing, and summaries that an eviction cut off
// finished by PiHarness's alarm, with no request. Needs ANTHROPIC_OAUTH_TOKEN (or an API key under that name) in .dev.vars.
// Writes proof-<time>.json and prints a summary.
import { spawn, execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8799), BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

let dev;
async function start() {
  // A server still on the port would answer instead of the new one.
  for (let i = 0; ; i++) { try { await fetch(`${BASE}/ready`); } catch { break; } if (i === 20) throw new Error(`Port ${PORT} is taken`); await sleep(500); }
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--log-level', 'warn'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  dev.stdout.on('data', d => process.stdout.write(`  [dev] ${d}`)); dev.stderr.on('data', d => process.stdout.write(`  [dev] ${d}`));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/ready`)).ok) return; } catch {} await sleep(500); }
  throw new Error('wrangler dev did not start');
}
/** The processes under `pid`: wrangler's workerd can leave its process group, so it is found by parent. */
const descendants = pid => {
  let children = [];
  try { children = execSync(`pgrep -P ${pid}`).toString().trim().split('\n').map(Number); } catch {}
  return children.flatMap(child => [child, ...descendants(child)]);
};
/** Kills wrangler and its workerd at once, as an eviction or a crash would: nothing gets to finish. */
function kill() {
  if (!dev) return;
  for (const pid of [dev.pid, ...descendants(dev.pid)]) try { process.kill(pid, 'SIGKILL'); } catch {}
  dev = undefined;
}
/** The local runtime's whole RSS (workerd with everything in it), not one agent's heap, which wrangler dev doesn't show. */
const workerdRss = () => {
  // The largest process under wrangler is workerd.
  try { return Math.max(...descendants(dev.pid).map(pid => Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()))) * 1024; } catch { return undefined; }
};
async function call(path, body) {
  const response = await fetch(`${BASE}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return path === '/view' ? response.text() : response.json();
}

// A board's year: short SMS lines and some long emails (over 512 bytes, so each gets a summary call).
const topics = ['elevator repair quote', 'parking rules vote', 'heating bill dispute', 'roof inspection', 'AGM minutes', 'laundry room schedule', 'bike storage', 'window replacement'];
const people = ['Kari (chair)', 'Ola (treasurer)', 'Ingrid (secretary)', 'Per (flat 3B)'];
const seed = Array.from({ length: 120 }, (_, i) => {
  const topic = topics[i % topics.length], who = people[i % people.length], date = new Date(Date.UTC(2026, 0, 1 + i * 2, 9)).toISOString();
  const text = i % 5 === 4
    ? `Email from ${who} about the ${topic}: ${`We received the offer of ${10_000 + i * 731} NOK from Byggmester ${i} AS. The board must decide by ${new Date(Date.UTC(2026, 0, 15 + i * 2)).toDateString()}. `.repeat(5)}Item ${i}.`
    : `${who}: ${['Can we put the', 'Reminder about the', 'Update on the', 'Question about the'][i % 4]} ${topic} on the agenda? (item ${i}, case ${(i * 7919) % 10007})`;
  return { kind: i % 3 === 2 ? 'talk' : 'user', text, date };
});
const prompts = [
  'Hi! Which topics has the board discussed most this year? One line.',
  'Use the zoom tool to read the very first message in memory, then tell me who sent it.',
  'What was the case number in that first message?',
  'Use the date tool on message 0 and tell me the date.',
  'Summarize what Ola (treasurer) has said about the heating bill, in two sentences. Zoom if you need detail.',
  'Thanks. Remind me: what did I ask you in my first question today?',
  'Draft a two-line SMS to Per about the bike storage.',
  'Translate your previous answer into Norwegian.',
];

const result = { started: new Date().toISOString(), seed: seed.length, turns: [], restarts: {} };
rmSync('.wrangler/state', { recursive: true, force: true });
try {
  await start();
  await call('/stats');
  result.runtimeRssBytesAtStart = workerdRss();
  log('seeding', seed.length, 'messages');
  await call('/seed', seed);
  let stats = await call('/settle');
  result.seeded = { entries: stats.entries, nodes: stats.nodes, summaryCalls: stats.summaryCalls, viewBytes: stats.viewBytes };
  log('seeded', result.seeded);
  for (const [n, text] of prompts.entries()) {
    const before = (await call('/stats')).requests.length;
    const answer = await call('/prompt', { text });
    stats = await call('/stats');
    result.turns.push({ prompt: text, ...answer, requests: stats.requests.slice(before) });
    log(`turn ${n + 1}`, answer.status, JSON.stringify(answer.text?.slice(0, 160)));
  }
  stats = await call('/settle');
  result.afterTurns = { entries: stats.entries, nodes: stats.nodes, pending: stats.pending, summaryCalls: stats.summaryCalls, runtimeRssBytes: workerdRss(), warnings: stats.warnings };
  result.tables = await call('/tables');
  result.log = await call('/log');

  // 1. A clean restart: everything was settled, so reopening must rebuild nothing.
  kill(); await sleep(1000); await start();
  stats = await call('/stats');
  result.restarts.clean = { entries: stats.entries, nodes: stats.nodes, pending: stats.pending, summaryCalls: stats.summaryCalls };
  log('clean restart', result.restarts.clean);

  // 2. An eviction mid-summary: a turn whose long answer needs summaries, killed as soon as it answers. After the restart no
  // request is sent; PiHarness's alarm must wake the object and OptChat's background task must finish the summaries.
  const answer = await call('/prompt', { text: 'Use zoom to read messages 4, 9, 14, 19, 24 and 29 in full, one call each, then reply only "read".' });
  const owed = await call('/stats');
  await sleep(300);
  const killedAt = Date.now();
  kill(); await sleep(1000); await start();
  log('evicted mid-summary; waiting 75s for the alarm, no requests');
  await sleep(75_000);
  stats = await call('/stats');
  result.restarts.evicted = { answer: answer.status, atKill: { entries: owed.entries, nodes: owed.nodes, pending: owed.pending, summaryCalls: owed.summaryCalls }, alarm: stats.alarm, objectStartedMsAfterRestart: Date.now() - stats.uptimeMs - killedAt, uptimeMs: stats.uptimeMs,
    entries: stats.entries, nodes: stats.nodes, pending: stats.pending, summaryCalls: stats.summaryCalls, warnings: stats.warnings,
    bootsSinceKill: stats.boots.filter(b => b.startedAt > killedAt).map(b => ({ startedSecondsAfterKill: (b.startedAt - killedAt) / 1000, summaryCalls: b.summaryCalls })) };
  log('after the alarm', result.restarts.evicted);

  // 3. The chat goes on after both restarts, with the earlier turns in its memory.
  const followUp = await call('/prompt', { text: 'What did I ask you to translate earlier today, and into which language?' });
  stats = await call('/settle');
  result.followUp = { ...followUp, requests: stats.requests.slice(-3) };
  log('follow-up', JSON.stringify(followUp.text?.slice(0, 200)));
  // A Pi entry logged twice repeats a message: the same receipt, kind and text.
  const final = await call('/log'), logged = final.filter(e => e.receipt).map(e => JSON.stringify([e.receipt, e.kind, e.text]));
  const relogged = logged.filter((key, i) => logged.indexOf(key) !== i);
  result.final = { entries: final.length, piEntriesLoggedTwice: relogged.length, view: await call('/view') };
} finally {
  kill();
  const file = `proof-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(result, null, 1));
  // Cache: what share of each main request's prompt came from the cache, after the first request.
  const requests = [...result.turns.flatMap(t => t.requests), ...result.followUp?.requests ?? []];
  const share = u => u.cacheRead / Math.max(1, u.input + u.cacheRead + u.cacheWrite);
  console.log(JSON.stringify({
    file, seeded: result.seeded, turns: result.turns.map(t => ({ status: t.status, requests: t.requests.map(u => `${u.input}/${u.cacheRead}/${u.cacheWrite}`) })),
    cacheHitAfterFirst: requests.length > 1 ? +(requests.slice(1).reduce((s, u) => s + u.cacheRead, 0) / requests.slice(1).reduce((s, u) => s + u.input + u.cacheRead + u.cacheWrite, 0)).toFixed(3) : undefined,
    perRequest: requests.map(u => +share(u).toFixed(2)),
    afterTurns: result.afterTurns, restarts: result.restarts, followUp: result.followUp?.text, final: result.final && { entries: result.final.entries, piEntriesLoggedTwice: result.final.piEntriesLoggedTwice },
  }, null, 1));
}
