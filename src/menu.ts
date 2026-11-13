import { Box, KeybindingsManager, SelectList, Spacer, Text, type SelectItem } from '@earendil-works/pi-tui';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { ModelChoice } from './profiles.ts';
import { count, oneLine } from './inspector.ts';
import { frame, showModel } from './settings-page.ts';

/** What `/optchat` offers, in menu order; each is also `/optchat <action>`. */
export const ACTIONS = ['profile', 'settings', 'model', 'agents', 'usage', 'activity', 'instructions', 'browse', 'import'] as const;
export type MenuAction = typeof ACTIONS[number];
const DESCRIPTIONS: Record<MenuAction, string> = {
  profile: 'Switch, create, or delete a profile',
  settings: 'Models, subagent limits, memory options',
  model: 'Compactor model and effort',
  agents: 'Live agent tree and saved runs',
  usage: 'Token usage and cost estimates',
  activity: 'Memory gauge and running agents',
  instructions: 'Edit this profile\'s AGENTS.md',
  browse: 'Open a readable snapshot of memory',
  import: 'Import history, or resume a paused import',
};

export interface MenuStatus { profile: string; messages: number; pending: number; compactor: ModelChoice; agents: ModelChoice; error?: string }
/** The status block as label and value; the plain menu outside the TUI shows the same rows. */
export const statusRows = (s: MenuStatus) => [
  ['Memory', `${count(s.messages)} messages · ${count(s.pending)} pending`],
  // config.json only checks these are strings, so one with a newline or escape code must not break the block.
  ['Compactor', oneLine(showModel(s.compactor))],
  ['Agents', oneLine(showModel(s.agents))],
] as const;
const failing = (error: string) => `Summaries failing: ${oneLine(error)}`;

/** The list both pages share: SelectList styled once, with the j/k movement, and a shortcut that can pre-empt a key. */
function sharedList(items: SelectItem[], theme: Theme, close: (value?: string) => void, redraw = () => {},
  shortcut?: (data: string, current: string | undefined) => boolean, maxVisible = 10) {
  const list = new SelectList(items, maxVisible, {
    selectedPrefix: t => theme.fg('accent', t), selectedText: t => theme.fg('accent', t),
    description: t => theme.fg('muted', t), scrollInfo: t => theme.fg('muted', t), noMatch: t => theme.fg('muted', t) },
    { minPrimaryColumnWidth: 1, maxPrimaryColumnWidth: Math.max(...items.map(i => i.label.length)) + 4 });
  list.onSelect = item => close(item.value);
  list.onCancel = () => close();
  const block = new Box(1, 0); block.addChild(list);
  return { block, handleInput: (data: string) => {
    if (!shortcut?.(data, list.getSelectedItem()?.value)) {
      // j and k move too, as in Pi's own select dialog that the pages replace.
      const step = data === 'j' ? 1 : data === 'k' ? -1 : 0, at = items.findIndex(item => item.value === list.getSelectedItem()?.value);
      if (step) list.setSelectedIndex(Math.max(0, Math.min(items.length - 1, at + step)));
      else list.handleInput(data);
    }
    redraw();
  } };
}

/** Framed like the settings page: title, the profile's status as aligned rows, then the actions with what each opens. */
export function optchatMenu(theme: Theme, title: string, status: MenuStatus | undefined, close: (action?: MenuAction) => void, redraw = () => {}) {
  const actions = sharedList(ACTIONS.map(value => ({ value, label: value, description: DESCRIPTIONS[value] })), theme,
    value => close(ACTIONS.find(a => a === value)), redraw);
  const rows = status ? statusRows(status) : [];
  const labels = Math.max(0, ...rows.map(([label]) => label.length));
  const facts = status ? rows.map(([label, value]) => new Text(`${theme.fg('muted', label.padEnd(labels))}  ${value}`, 1, 0)) : [new Text(theme.fg('muted', 'No active profile'), 1, 0)];
  if (status?.error) facts.push(new Text(theme.fg('warning', failing(status.error)), 1, 0));
  const page = frame(theme, title, status?.profile, [new Spacer(1), ...facts, new Spacer(1), actions.block, new Spacer(1),
    new Text(theme.fg('dim', '↑↓ select · Enter open · Esc close'), 1, 0)]);
  return Object.assign(page, { handleInput: actions.handleInput });
}

/** The profile list's own entry for creating one; never a valid profile name (the pattern allows lowercase only). */
export const CREATE_PROFILE = '+ Create profile';
/** What the picker returns: a profile to open, a profile to delete, or nothing for a cancel. */
export type ProfilePick = string | { delete: string } | undefined;

/** The picker's own word for a binding, so a user who rebinds delete is not shown a key that does nothing. */
function keyLabel(key: string) {
  return key.replace(/(^|\+)([a-z0-9])/g, (_match, separator: string, character: string) => separator + character.toUpperCase());
}

/** The profile list: Pi's session list for profiles, so the user's delete key removes the highlighted profile the way it removes a session there. */
export function profilePicker(theme: Theme, keys: KeybindingsManager, names: string[], close: (pick?: ProfilePick) => void, redraw = () => {}) {
  const items = [...names.map(name => ({ value: name, label: name })), { value: CREATE_PROFILE, label: CREATE_PROFILE }];
  const picker = sharedList(items, theme, value => close(value), redraw, (data, current) => {
    // Delete goes through the user's keybindings, so it fires in every terminal encoding Pi reads; the create row is not a profile to delete.
    if (!keys.matches(data, 'app.session.delete')) return false;
    if (current && current !== CREATE_PROFILE) close({ delete: current });
    return true;
  });
  const deleteKey = keys.getKeys('app.session.delete')[0];
  const hint = names.length ? `↑↓ select · Enter open · ${deleteKey ? `${keyLabel(deleteKey)} delete · ` : ''}Esc cancel` : 'Enter create · Esc cancel';
  const page = frame(theme, 'OptChat profile', undefined, [new Spacer(1), picker.block, new Spacer(1),
    new Text(theme.fg('dim', hint), 1, 0)]);
  return Object.assign(page, { handleInput: picker.handleInput });
}

/** The menu in interactive Pi; elsewhere (RPC hosts) Pi's plain select with the same facts and actions. */
export function showMenu(ctx: ExtensionContext, title: string, status: MenuStatus | undefined): Promise<MenuAction | undefined> {
  if (ctx.mode === 'tui') return ctx.ui.custom<MenuAction | undefined>((tui, theme, _keys, done) => optchatMenu(theme, title, status, done, () => tui.requestRender()));
  const facts = status ? [status.profile, ...statusRows(status).map(([label, value]) => `${label}: ${value}`), ...status.error ? [failing(status.error)] : []] : ['No active profile'];
  return ctx.ui.select([title, ...facts].join('\n'), [...ACTIONS]).then(choice => ACTIONS.find(a => a === choice));
}
