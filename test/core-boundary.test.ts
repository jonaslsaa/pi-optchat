import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// src/core is what hosts other than Pi import, such as Pi Durable in a Cloudflare Worker: it may use pi-ai's types, but nothing
// from Pi or Node at runtime.
test('core imports only itself, typebox and pi-ai types, and uses no Node globals', () => {
  const dir = new URL('../src/core/', import.meta.url);
  const problems = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts')).flatMap(file => {
    const url = new URL(file, dir), source = readFileSync(url, 'utf8');
    // One statement at a time: `[^;]` keeps a match from running on into the next one.
    const imports = [...source.matchAll(/^(?:import|export)\b([^;]*?)\bfrom\s*(['"])([^'"]+)\2/gm)].flatMap(([, what, , from]) =>
      from.startsWith('.') ? new URL(from, url).href.startsWith(dir.href) ? [] : [`${file}: ${from}`]
      : from === 'typebox' || (from === '@earendil-works/pi-ai' && /^\s*type\b/.test(what)) ? [] : [`${file}: ${from}`]);
    const others = [...source.matchAll(/^import\s*['"][^'"]+['"]|\bimport\(|\b(?:Buffer|process|require|__dirname|__filename|setImmediate)\s*(?:\?\.|[.([])/gm)]
      .map(([match]) => `${file}: ${match}`);
    return [...imports, ...others];
  });
  assert.deepEqual(problems, []);
});
