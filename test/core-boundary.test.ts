import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/** What the files in src/`folder` import from outside it that `allowed` refuses, and the Node globals they use. */
function outside(folder: string, allowed: (from: string, typeOnly: boolean) => boolean) {
  const dir = new URL(`../src/${folder}/`, import.meta.url);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts')).flatMap(file => {
    const url = new URL(file, dir), source = readFileSync(url, 'utf8');
    // One statement at a time: `[^;]` keeps a match from running on into the next one.
    const imports = [...source.matchAll(/^(?:import|export)\b([^;]*?)\bfrom\s*(['"])([^'"]+)\2/gm)].flatMap(([, what, , from]) => {
      const target = from.startsWith('.') ? new URL(from, url).href : from;
      return target.startsWith(dir.href) || allowed(target, /^\s*type\b/.test(what)) ? [] : [`${file}: ${from}`];
    });
    const others = [...source.matchAll(/^import\s*['"][^'"]+['"]|\bimport\(|\b(?:Buffer|process|require|__dirname|__filename|setImmediate)\s*(?:\?\.|[.([])/gm)]
      .map(([match]) => `${file}: ${match}`);
    return [...imports, ...others];
  });
}

// src/core is what hosts other than Pi import, such as Pi Durable in a Cloudflare Worker: it may use pi-ai's types, but nothing
// from Pi or Node at runtime.
test('core imports only itself, typebox and pi-ai types, and uses no Node globals', () => {
  assert.deepEqual(outside('core', (from, typeOnly) => from === 'typebox' || (from === '@earendil-works/pi-ai' && typeOnly)), []);
});

// src/durable runs in a Worker beside Pi Durable: it may use core, typebox and Pi Durable, but not Pi's terminal app or Node.
test('durable imports only core, typebox and Pi Durable, and uses no Node globals', () => {
  const core = new URL('../src/core/index.ts', import.meta.url).href;
  assert.deepEqual(outside('durable', from => from === core || from === 'typebox' || from === '@earendil-works/pi-durable' || from.startsWith('@earendil-works/pi-durable/')), []);
});
