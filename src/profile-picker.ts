import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { record } from './core/cache.ts';
import { dataHome, listProfiles, profilePath } from './profiles.ts';
import { atomicWrite } from './store.ts';

/** A user preference, independent of which profile was opened most recently. */
export function readDefaultProfile(): string | undefined {
  let name: string;
  try { name = readFileSync(join(dataHome(), 'default-profile'), 'utf8').trim(); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
  profilePath(name); // Validate before displaying it or using it as a path.
  return name;
}
export function saveDefaultProfile(name: string | undefined) {
  const path = join(dataHome(), 'default-profile');
  if (name === undefined) {
    try { unlinkSync(path); } catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
  } else {
    if (!listProfiles().includes(name)) throw new Error(`No profile named ${name}.`);
    atomicWrite(path, `${name}\n`);
  }
}
export function preferredProfile(ctx: ExtensionContext) {
  try {
    const name = readDefaultProfile();
    return name && listProfiles().includes(name) ? name : undefined;
  } catch (error) {
    ctx.ui.notify(`Could not read the default profile: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    return undefined;
  }
}

/** Setting a default changes later startups, never the current selection or a session's binding. */
export async function pickProfile(ctx: ExtensionContext, choices: string[]) {
  for (;;) {
    const current = preferredProfile(ctx), settings = `Default profile: ${current ?? 'automatic'}`;
    const selected = await ctx.ui.select('OptChat profile', [...choices, settings]);
    if (selected !== settings) return selected;
    const clear = 'No saved default', name = await ctx.ui.select('Default for new interactive sessions (flags and OPTCHAT_PROFILE take precedence)', [...listProfiles(), clear]);
    if (name === undefined) continue;
    try { saveDefaultProfile(name === clear ? undefined : name); }
    catch (error) { ctx.ui.notify(`Could not save the default profile: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
  }
}
