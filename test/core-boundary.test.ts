import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/** What a source file imports and re-exports: each specifier, resolved against `url` when relative, and whether it is type-only. */
// One statement at a time: `[^;]` keeps a match from running on into the next one.
const imports = (source: string, url: URL) => [...source.matchAll(/^(?:import|export)\b([^;]*?)\bfrom\s*(['"])([^'"]+)\2/gm)]
  .map(([, what, , from]) => ({ from, target: from.startsWith('.') ? new URL(from, url).href : from, typeOnly: /^\s*type\b/.test(what) }));

/** What the files in src/`folder` import from outside it that `allowed` refuses, and the Node globals they use. */
function outside(folder: string, allowed: (from: string, typeOnly: boolean) => boolean) {
  const dir = new URL(`../src/${folder}/`, import.meta.url);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts')).flatMap(file => {
    const url = new URL(file, dir), source = readFileSync(url, 'utf8');
    const refused = imports(source, url).flatMap(({ from, target, typeOnly }) => target.startsWith(dir.href) || allowed(target, typeOnly) ? [] : [`${file}: ${from}`]);
    const others = [...source.matchAll(/^import\s*['"][^'"]+['"]|\bimport\(|\b(?:Buffer|process|require|__dirname|__filename|setImmediate)\s*(?:\?\.|[.([])/gm)]
      .map(([match]) => `${file}: ${match}`);
    return [...refused, ...others];
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

// pi-optchat/files is for another app on the machine, which has Node but not Pi: everything it reaches, types included, needs only
// Node and, as core does, pi-ai's types.
test('files reaches only Node and pi-ai types, besides its own modules', () => {
  const seen = new Set<string>(), refused = new Set<string>();
  const visit = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    for (const { from, target, typeOnly } of imports(readFileSync(url, 'utf8'), url)) {
      if (from.startsWith('.')) visit(new URL(target));
      else if (!from.startsWith('node:') && !(from === '@earendil-works/pi-ai' && typeOnly)) refused.add(from);
    }
  };
  visit(new URL('../src/files.ts', import.meta.url));
  assert.deepEqual([...refused], []);
});
