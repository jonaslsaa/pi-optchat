import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { version } from '../src/index.ts';

test('the version shown in /optchat is the one in package.json', () => {
  const manifest: { version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version, manifest.version);
});
