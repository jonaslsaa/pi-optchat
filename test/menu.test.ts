import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { CREATE_PROFILE, optchatMenu, profilePicker, type MenuAction, type ProfilePick } from '../src/menu.ts';
import { defaults } from '../src/profiles.ts';

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const status = { profile: 'personal', messages: 5251, pending: 1, compactor: defaults.compactor, agents: defaults.subagent, error: 'Rate limited' };

test('/optchat shows the profile status as aligned rows and returns the chosen action', () => {
  const chosen: (MenuAction | undefined)[] = [];
  const menu = optchatMenu(plain, 'OptChat v1.2.3', status, action => chosen.push(action));
  const lines = menu.render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' OptChat v1.2.3 · personal'));
  assert.ok(lines.includes(' Memory     5,251 messages · 1 pending'));
  assert.ok(lines.includes(' Compactor  anthropic/claude-sonnet-5-5 · medium'));
  assert.ok(lines.includes(' Summaries failing: Rate limited'));
  menu.handleInput('j'); menu.handleInput('\r');
  menu.handleInput('\x1b');
  assert.deepEqual(chosen, ['settings', undefined]);
});

test('/optchat without a profile says so and keeps every action', () => {
  const lines = optchatMenu(plain, 'OptChat', undefined, () => {}).render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' OptChat') && lines.includes(' No active profile'));
  assert.ok(lines.some(line => line.includes('import') && line.includes('Import history')));
});

test('/optchat profile lists the profiles and deletes the highlighted one on Ctrl+D', () => {
  const picks: ProfilePick[] = [];
  const picker = profilePicker(plain, ['personal', 'work'], pick => picks.push(pick));
  const lines = picker.render(80).map(line => line.trimEnd());
  assert.ok(lines.some(line => line.includes('OptChat profile')));
  assert.ok(lines.some(line => line.includes('Ctrl+D delete')));
  assert.ok(lines.some(line => line.includes(CREATE_PROFILE)));
  picker.handleInput('j');
  picker.handleInput('\x04');
  assert.deepEqual(picks, [{ delete: 'work' }]);
});

test('Ctrl+D on the create row asks for nothing, and Enter still opens the row', () => {
  const picks: ProfilePick[] = [];
  const picker = profilePicker(plain, ['only'], pick => picks.push(pick));
  picker.handleInput('j');
  picker.handleInput('\x04');
  assert.deepEqual(picks, [], 'the create row is not a profile to delete');
  picker.handleInput('\r');
  assert.deepEqual(picks, [CREATE_PROFILE]);
});

test('Escape cancels the picker, and a list with no profiles still offers create', () => {
  const picks: ProfilePick[] = [];
  const picker = profilePicker(plain, [], pick => picks.push(pick));
  assert.ok(picker.render(80).some(line => line.includes('Enter create')));
  picker.handleInput('\x1b');
  assert.deepEqual(picks, [undefined]);
});
