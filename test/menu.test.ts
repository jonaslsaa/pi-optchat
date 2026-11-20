import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATE_PROFILE, optchatMenu, profilePicker, type MenuAction, type ProfilePick } from '../src/menu.ts';
import { defaults } from '../src/profiles.ts';
import { KeybindingsManager } from '@earendil-works/pi-tui';
import { pickerKeys, plainTheme } from './support.ts';

const status = { profile: 'personal', messages: 5251, pending: 1, compactor: defaults.compactor, agents: defaults.subagent, error: 'Rate limited' };

test('/optchat shows the profile status as aligned rows and returns the chosen action', () => {
  const chosen: (MenuAction | undefined)[] = [];
  const menu = optchatMenu(plainTheme, 'OptChat v1.2.3', status, action => chosen.push(action));
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
  const lines = optchatMenu(plainTheme, 'OptChat', undefined, () => {}).render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' OptChat') && lines.includes(' No active profile'));
  assert.ok(lines.some(line => line.includes('import') && line.includes('Import history')));
});

test('/optchat profile lists profiles, and its keys decide delete, create and cancel', () => {
  const picks: ProfilePick[] = [];
  const picker = profilePicker(plainTheme, pickerKeys, ['only'], pick => picks.push(pick));
  const lines = picker.render(80).map(line => line.trimEnd());
  assert.ok(lines.some(line => line.includes('OptChat profile')));
  assert.ok(lines.some(line => line.includes('Ctrl+D delete')));
  assert.ok(lines.some(line => line.includes(CREATE_PROFILE)));
  picker.handleInput('j'); // now on the create row
  picker.handleInput('\x04');
  assert.deepEqual(picks, [], 'the create row is not a profile to delete');
  picker.handleInput('k'); // back on the profile row
  picker.handleInput('\x04');
  assert.deepEqual(picks, [{ delete: 'only' }]);
  // A list with no profiles still offers create; Enter opens the row, Esc cancels.
  const fresh: ProfilePick[] = [];
  const empty = profilePicker(plainTheme, pickerKeys, [], pick => fresh.push(pick));
  assert.ok(empty.render(80).some(line => line.includes('Enter create')));
  empty.handleInput('j'); empty.handleInput('\r');
  assert.deepEqual(fresh, [CREATE_PROFILE]);
  empty.handleInput('\x1b');
  assert.deepEqual(fresh, [CREATE_PROFILE, undefined]);
});

test('/optchat profile names the delete key the user bound, not always Ctrl+D', () => {
  const rebound = new KeybindingsManager({ 'app.session.delete': { defaultKeys: 'alt+d' } });
  const lines = profilePicker(plainTheme, rebound, ['only'], () => {}).render(80).map(line => line.trimEnd());
  assert.ok(lines.some(line => line.includes('Alt+D delete')), 'the hint follows the binding');
  assert.ok(!lines.some(line => line.includes('Ctrl+D')), 'a key that does nothing is not named');
});

test('the picker walks past the ten rows it shows at once', () => {
  const names = Array.from({ length: 12 }, (_, index) => `p${index}`);
  const picks: ProfilePick[] = [];
  const picker = profilePicker(plainTheme, pickerKeys, names, pick => picks.push(pick));
  const selected = () => picker.render(80).map(line => line.trim()).find(line => line.startsWith('→'))?.replace(/^→\s*/, '');
  for (let step = 0; step < 11; step++) picker.handleInput('j');
  assert.equal(selected(), 'p11', 'the list scrolled to the last row');
  picker.handleInput('\x04');
  assert.deepEqual(picks, [{ delete: 'p11' }]);
});
