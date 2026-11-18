import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { profilePicker, type ProfileOption } from '../src/profile-picker.ts';
import type { ProfileChoice } from '../src/project-profiles.ts';

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const choices: ProfileOption[] = [{ label: 'work (in-use)', profile: 'work' }, { label: 'personal', profile: 'personal' },
  { label: '+ Create profile', create: 'global' }, { label: 'none', profile: null }];

test('D changes the default inline, without selecting it; none is last and initially marked default', () => {
  const opened: (ProfileOption | undefined)[] = [], saved: ProfileChoice[] = [];
  const picker = profilePicker(plain, choices, null, value => opened.push(value), value => saved.push(value));
  const screen = () => picker.render(100).join('\n');
  assert.match(screen(), /none \(default\)/);
  assert.match(screen(), /D set default/);
  assert.doesNotMatch(screen(), /Default profile:/);
  picker.handleInput('d'); assert.deepEqual(saved, [], 'lowercase d does not change the default');
  picker.handleInput('D');
  assert.deepEqual(saved, ['work']); assert.deepEqual(opened, []);
  assert.match(screen(), /work \(in-use\) \(default\)/);
  assert.doesNotMatch(screen(), /none \(default\)/);
  picker.handleInput('j'); picker.handleInput('j'); picker.handleInput('D');
  assert.deepEqual(saved, ['work'], 'creation actions cannot become defaults');
  picker.handleInput('j'); picker.handleInput('\x1b[100;2u'); // Kitty Shift+D
  assert.deepEqual(saved, ['work', null]);
  assert.match(screen(), /none \(default\)/);
  picker.handleInput('\r');
  assert.deepEqual(opened, [choices.at(-1)]);
});

test('a failed default write keeps the old marker and displays the failure; Escape cancels', () => {
  const opened: (ProfileOption | undefined)[] = [];
  const picker = profilePicker(plain, choices, null, value => opened.push(value), () => { throw new Error('disk full'); });
  picker.handleInput('D');
  const screen = picker.render(100).join('\n');
  assert.match(screen, /none \(default\)/); assert.match(screen, /disk full/);
  picker.handleInput('\x1b'); assert.deepEqual(opened, [undefined]);
});

test('project defaults use their directory identity, and selection scrolls beyond ten entries', () => {
  const project = { kind: 'project', dir: '/repo/.pi/optchat' } as const;
  const entries: ProfileOption[] = [...Array.from({ length: 12 }, (_, i) => ({ label: `p${i}`, profile: `p${i}` })),
    { label: 'repo (this project)', profile: project }, { label: 'none', profile: null }];
  let opened: ProfileOption | undefined;
  const picker = profilePicker(plain, entries, { ...project }, choice => { opened = choice; }, () => {});
  for (let i = 0; i < 12; i++) picker.handleInput('j');
  assert.match(picker.render(100).join('\n'), /repo \(this project\) \(default\)/);
  picker.handleInput('\r'); assert.deepEqual(opened, entries[12]);
});
