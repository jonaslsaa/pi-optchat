import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Box, matchesKey, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { record } from './core/cache.ts';
import { dataHome, listProfiles, profilePath } from './profiles.ts';
import { parseProfileBinding, prepareProjectProfile, profileBinding, sameProfile, type ProfileChoice } from './project-profiles.ts';
import { frame } from './settings-page.ts';
import { atomicWrite } from './store.ts';

/** A user preference, independent of which profile was opened most recently. Legacy name-only files still work. */
export function readDefaultProfile(): ProfileChoice | undefined {
  let text: string;
  try { text = readFileSync(join(dataHome(), 'default-profile'), 'utf8').trim(); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
  if (text.startsWith('{')) {
    const profile = parseProfileBinding(JSON.parse(text));
    if (profile === undefined) throw new Error('Invalid default profile.');
    return profile;
  }
  profilePath(text);
  return text;
}
export function saveDefaultProfile(profile: ProfileChoice | undefined) {
  const path = join(dataHome(), 'default-profile');
  if (profile == null) {
    try { unlinkSync(path); } catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
  } else {
    if (typeof profile === 'string') {
      if (!listProfiles().includes(profile)) throw new Error(`No profile named ${profile}.`);
    } else prepareProjectProfile(profile);
    atomicWrite(path, `${typeof profile === 'string' ? profile : JSON.stringify(profileBinding(profile))}\n`);
  }
}
export function preferredProfile(ctx: ExtensionContext): ProfileChoice {
  try {
    const profile = readDefaultProfile();
    if (typeof profile === 'string') return listProfiles().includes(profile) ? profile : null;
    return profile ?? null;
  } catch (error) {
    ctx.ui.notify(`Could not read the default profile: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    return null;
  }
}

export type ProfileOption = { label: string; profile: ProfileChoice } | { label: string; create: 'global' | 'project' };

/** D changes future startups without closing the picker or changing the current session. */
export function profilePicker(theme: Theme, choices: ProfileOption[], current: ProfileChoice, close: (choice?: ProfileOption) => void,
  save: (profile: ProfileChoice) => void, redraw = () => {}, plainOnCancel = false) {
  const items = choices.map((choice, index) => ({ value: String(index), label: choice.label }));
  const labels = () => { for (const [index, choice] of choices.entries()) items[index].label = `${choice.label}${'profile' in choice && sameProfile(current, choice.profile) ? ' (default)' : ''}`; };
  labels();
  const list = new SelectList(items, 10, {
    selectedPrefix: t => theme.fg('accent', t), selectedText: t => theme.fg('accent', t),
    description: t => theme.fg('muted', t), scrollInfo: t => theme.fg('muted', t), noMatch: t => theme.fg('muted', t),
  });
  list.onSelect = item => close(choices[Number(item.value)]);
  list.onCancel = () => close(plainOnCancel ? { label: 'none', profile: null } : undefined);
  const box = new Box(1, 0); box.addChild(list);
  const error = new Text('', 1, 0);
  const page = frame(theme, 'OptChat profile', undefined, [new Spacer(1), box, error, new Spacer(1),
    new Text(theme.fg('dim', `↑↓ select · Enter open · D set default · Esc ${plainOnCancel ? 'none' : 'cancel'}`), 1, 0)]);
  return Object.assign(page, { handleInput: (data: string) => {
    const at = Number(list.getSelectedItem()?.value), choice = choices[at];
    if (data === 'D' || matchesKey(data, 'shift+d')) {
      if (choice && 'profile' in choice) {
        try { save(choice.profile); current = choice.profile; labels(); error.setText(''); }
        catch (e) { error.setText(theme.fg('error', `Could not save the default profile: ${e instanceof Error ? e.message : String(e)}`)); }
      }
    } else if (data === 'j' || data === 'k') list.setSelectedIndex(Math.max(0, Math.min(choices.length - 1, at + (data === 'j' ? 1 : -1))));
    else list.handleInput(data);
    redraw();
  } });
}
export function pickProfile(ctx: ExtensionContext, choices: ProfileOption[], plainOnCancel = false) {
  return ctx.ui.custom<ProfileOption | undefined>((tui, theme, _keys, done) =>
    profilePicker(theme, choices, preferredProfile(ctx), done, saveDefaultProfile, () => tui.requestRender(), plainOnCancel));
}
