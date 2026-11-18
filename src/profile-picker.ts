import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Box, matchesKey, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { record } from './core/cache.ts';
import { dataHome, listProfiles, profilePath } from './profiles.ts';
import { parseProfileBinding, type ProfileChoice } from './project-profiles.ts';
import { frame } from './settings-page.ts';
import { atomicWrite } from './store.ts';

/** A user preference, independent of which profile was opened most recently. Legacy name-only files still work. */
export function readDefaultProfile(): string | undefined {
  let text: string;
  try { text = readFileSync(join(dataHome(), 'default-profile'), 'utf8').trim(); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
  if (text.startsWith('{')) {
    const profile = parseProfileBinding(JSON.parse(text));
    if (profile === undefined) throw new Error('Invalid default profile.');
    // Earlier builds allowed project defaults. Ignore them without touching their memory or session bindings.
    if (typeof profile !== 'string') return undefined;
    text = profile;
  }
  profilePath(text);
  return text;
}
export function saveDefaultProfile(profile: string | null | undefined) {
  const path = join(dataHome(), 'default-profile');
  if (profile == null) {
    try { unlinkSync(path); } catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
  } else {
    if (typeof profile !== 'string') throw new Error('Only global profiles can be the default.');
    if (!listProfiles().includes(profile)) throw new Error(`No profile named ${profile}.`);
    atomicWrite(path, `${profile}\n`);
  }
}
export function preferredProfile(ctx: ExtensionContext): string | null {
  try {
    const profile = readDefaultProfile();
    return profile && listProfiles().includes(profile) ? profile : null;
  } catch (error) {
    ctx.ui.notify(`Could not read the default profile: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    return null;
  }
}

export type ProfileOption = { label: string; profile: ProfileChoice } | { label: string; create: 'global' | 'project' };
const canSetDefault = (choice?: ProfileOption): choice is { label: string; profile: string | null } =>
  !!choice && 'profile' in choice && (choice.profile === null || typeof choice.profile === 'string');

/** D changes future startups without closing the picker or changing the current session. */
export function profilePicker(theme: Theme, choices: ProfileOption[], current: string | null, close: (choice?: ProfileOption) => void,
  save: (profile: string | null) => void, redraw = () => {}, plainOnCancel = false) {
  const items = choices.map((choice, index) => ({ value: String(index), label: choice.label }));
  const labels = () => { for (const [index, choice] of choices.entries()) items[index].label = `${choice.label}${canSetDefault(choice) && current === choice.profile ? ' (default)' : ''}`; };
  labels();
  const list = new SelectList(items, 10, {
    selectedPrefix: t => theme.fg('accent', t), selectedText: t => theme.fg('accent', t),
    description: t => theme.fg('muted', t), scrollInfo: t => theme.fg('muted', t), noMatch: t => theme.fg('muted', t),
  });
  list.onSelect = item => close(choices[Number(item.value)]);
  list.onCancel = () => close(plainOnCancel ? { label: 'none', profile: null } : undefined);
  const box = new Box(1, 0); box.addChild(list);
  const error = new Text('', 1, 0);
  const hint = new Text('', 1, 0);
  const updateHint = () => hint.setText(theme.fg('dim', `↑↓ select · Enter open${canSetDefault(choices[Number(list.getSelectedItem()?.value)]) ? ' · D set default' : ''} · Esc ${plainOnCancel ? 'none' : 'cancel'}`));
  updateHint();
  const page = frame(theme, 'OptChat profile', undefined, [new Spacer(1), box, error, new Spacer(1),
    hint]);
  return Object.assign(page, { handleInput: (data: string) => {
    const at = Number(list.getSelectedItem()?.value), choice = choices[at];
    if (data === 'D' || matchesKey(data, 'shift+d')) {
      if (canSetDefault(choice)) {
        try { save(choice.profile); current = choice.profile; labels(); error.setText(''); }
        catch (e) { error.setText(theme.fg('error', `Could not save the default profile: ${e instanceof Error ? e.message : String(e)}`)); }
      }
    } else if (data === 'j' || data === 'k') list.setSelectedIndex(Math.max(0, Math.min(choices.length - 1, at + (data === 'j' ? 1 : -1))));
    else list.handleInput(data);
    updateHint();
    redraw();
  } });
}
export function pickProfile(ctx: ExtensionContext, choices: ProfileOption[], plainOnCancel = false) {
  return ctx.ui.custom<ProfileOption | undefined>((tui, theme, _keys, done) =>
    profilePicker(theme, choices, preferredProfile(ctx), done, saveDefaultProfile, () => tui.requestRender(), plainOnCancel));
}
