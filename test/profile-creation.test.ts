import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, defaults, instructions, listProfiles, loadConfig, profilePath, templatePath } from '../src/profiles.ts';
import { removeDir } from './support.ts';

function sandbox() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'oc-create-')), previous = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  return () => {
    mock.restoreAll(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previous;
    removeDir(dir);
  };
}

for (const file of ['config.json', 'AGENTS.md']) {
  test(`failed ${file} write leaves no profile and the same name can be retried`, () => {
    const cleanup = sandbox(), failure = new Error(`injected ${file} write failure`);
    try {
      const original = fs.renameSync;
      const rename = mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).endsWith(file)) throw failure;
        return original(from, to);
      });
      syncBuiltinESMExports();
      assert.throws(() => createProfile('retry'), error => error === failure);
      assert.ok(!fs.existsSync(profilePath('retry')));
      assert.deepEqual(listProfiles(), []);
      rename.mock.restore(); syncBuiltinESMExports();
      createProfile('retry');
      assert.deepEqual(loadConfig(profilePath('retry')), defaults);
      assert.match(instructions(profilePath('retry')), /This is the retry profile/);
      assert.deepEqual(fs.readdirSync(profilePath('retry')).sort(), ['AGENTS.md', 'config.json']);
    } finally { cleanup(); }
  });
}

test('an existing profile is preserved when creation is refused', () => {
  const cleanup = sandbox();
  try {
    const dir = profilePath('existing'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'notes.txt'), 'keep my data');
    assert.throws(() => createProfile('existing'), /Profile already exists/);
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
    assert.equal(fs.readFileSync(join(dir, 'notes.txt'), 'utf8'), 'keep my data');
  } finally { cleanup(); }
});

test('a competing creator that claims the directory first keeps its files', () => {
  const cleanup = sandbox();
  try {
    const dir = profilePath('race'), original = fs.mkdirSync;
    mock.method(fs, 'mkdirSync', (path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (path === dir) {
        original(dir);
        fs.writeFileSync(join(dir, 'notes.txt'), 'other creator');
      }
      return original(path, options);
    });
    syncBuiltinESMExports();
    assert.throws(() => createProfile('race'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST');
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
    assert.equal(fs.readFileSync(join(dir, 'notes.txt'), 'utf8'), 'other creator');
  } finally { cleanup(); }
});

function writeTemplate(config?: unknown, agents?: string) {
  fs.mkdirSync(templatePath(), { recursive: true });
  if (config !== undefined) fs.writeFileSync(join(templatePath(), 'config.json'), JSON.stringify(config));
  if (agents !== undefined) fs.writeFileSync(join(templatePath(), 'AGENTS.md'), agents);
}

const templateConfig = {
  compactor: { provider: 'openai', model: 'gpt-5-mini', thinking: 'low' },
  subagent: { provider: 'openai', model: 'gpt-5', thinking: 'high' },
  main: { provider: 'openai', model: 'gpt-5', thinking: 'medium' },
  memorySearch: true, jobs: 4, refreshAt: 0.5, maxAgents: 2,
};

test('a template config.json and AGENTS.md seed a new profile', () => {
  const cleanup = sandbox();
  try {
    writeTemplate(templateConfig, '# house rules\n\nKeep replies short.');
    createProfile('seeded');
    const dir = profilePath('seeded');
    assert.deepEqual(loadConfig(dir), { ...defaults, ...templateConfig });
    assert.equal(instructions(dir), '# house rules\n\nKeep replies short.');
  } finally { cleanup(); }
});

test('a template without AGENTS.md keeps the placeholder', () => {
  const cleanup = sandbox();
  try {
    writeTemplate(templateConfig);
    createProfile('placeholder');
    assert.match(instructions(profilePath('placeholder')), /This is the placeholder profile/);
  } finally { cleanup(); }
});

test('a partial template takes the built-in models and settings', () => {
  const cleanup = sandbox();
  try {
    writeTemplate({ compactor: { provider: 'openai', model: 'gpt-5-mini', thinking: 'low' } });
    createProfile('partial');
    assert.deepEqual(loadConfig(profilePath('partial')), { ...defaults, compactor: { provider: 'openai', model: 'gpt-5-mini', thinking: 'low' } });
  } finally { cleanup(); }
});

test('an invalid template leaves no profile and is not replaced by the defaults', () => {
  const cleanup = sandbox();
  try {
    writeTemplate({ compactor: { provider: 'openai', model: 'gpt-5-mini', thinking: 'turbo' } });
    assert.throws(() => createProfile('invalid'), /Invalid profile template/);
    assert.deepEqual(listProfiles(), []);
  } finally { cleanup(); }
});
