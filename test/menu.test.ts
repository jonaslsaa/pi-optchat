import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager } from '@earendil-works/pi-tui';
import { CREATE_PROFILE, optchatMenu, profilePicker, type MenuAction, type ProfilePick } from '../src/menu.ts';
import { defaults } from '../src/profiles.ts';

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const status = { profile: 'personal', messages: 5251, pending: 1, compactor: defaults.compactor, agents: defaults.subagent, error: 'Rate limited' };
/** The real matcher, pointing the delete keybinding at Pi's default for the session list. */
const keys = new KeybindingsManager({ 'app.session.delete': { defaultKeys: 'ctrl+d' } } as never);

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

test('/optchat profile lists profiles, and its keys decide delete, create and cancel', () => {
  const picks: ProfilePick[] = [];
  const picker = profilePicker(plain, keys, ['only'], pick => picks.push(pick));
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
  const empty = profilePicker(plain, keys, [], pick => fresh.push(pick));
  assert.ok(empty.render(80).some(line => line.includes('Enter create')));
  empty.handleInput('j'); empty.handleInput('\r');
  assert.deepEqual(fresh, [CREATE_PROFILE]);
  empty.handleInput('\x1b');
  assert.deepEqual(fresh, [CREATE_PROFILE, undefined]);
});
