import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// src/core is what hosts other than Pi import, such as Pi Durable in a Cloudflare Worker: it may use pi-ai's types, but nothing
// from Pi or Node at runtime.
test('core imports only itself, typebox and pi-ai types, and uses no Node globals', () => {
  const dir = new URL('../src/core/', import.meta.url);
  const problems = readdirSync(dir).filter(file => file.endsWith('.ts')).flatMap(file => {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const imports = [...source.matchAll(/^(?:import|export)\b(.*?)\bfrom '([^']+)'/gms)].flatMap(([, what, from]) =>
      /^\.\/[\w-]+\.ts$/.test(from) || from === 'typebox' || (from === '@earendil-works/pi-ai' && /^ type\b/.test(what)) ? [] : [`${file}: ${from}`]);
    const others = [...source.matchAll(/^import '[^']+'|\bimport\(|\b(Buffer|process|require|__dirname)\s*[.(]/gm)].map(([match]) => `${file}: ${match}`);
    return [...imports, ...others];
  });
  assert.deepEqual(problems, []);
});
