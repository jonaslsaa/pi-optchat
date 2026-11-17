import { record } from '../core/cache.ts';
import { connectWindow, type ImportAction } from '../window-client.ts';
import { lockProfile, ProfileBusyError, profileOwner } from '../profiles.ts';
import { discardImport, readImport } from './job.ts';
import type { ImportSelection } from './plan.ts';

// Another app's import, through the Pi that owns the profile: it alone may write the profile, and only it has the compactor. Pi-free.

/** Imports may carry thousands of conversations: under the socket's 4 MB frame, with room for JSON escaping. */
const SELECTION_LIMIT = 3_000_000;
/** Starting reads every chosen conversation before it replies. */
const STARTING = 10 * 60_000;

/** An import that ends (finished, paused, failed) restarts its Pi's session, which reopens the profile and its socket a moment later. */
const REOPENING = 5000;

async function ask(profileDirectory: string, action: ImportAction, text?: string) {
  const since = Date.now();
  const connect = (): ReturnType<typeof connectWindow> => connectWindow(profileDirectory, () => {}, () => {}).catch(async (error: unknown) => {
    const code = error instanceof Error && record(error.cause) ? error.cause.code : undefined;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED' || Date.now() - since > REOPENING) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
    return connect();
  });
  const connection = await connect();
  try { await connection.request(action, text, undefined, { timeout: STARTING, limit: SELECTION_LIMIT }); }
  finally { connection.close(); }
  return readImport(profileDirectory);
}

/**
 * Starts importing `selection` in the Pi that has the profile open, and returns once the import is staged and running (`readImport`
 * follows it). Throws the reason it can't: no Pi has the profile open, it is busy (a turn, subagents, reports), an import is pending,
 * or nothing is new. When the import ends (finished, paused or failed) that Pi starts a new session, as `/optchat import` does.
 */
export async function startImport(profileDirectory: string, selection: ImportSelection) {
  const { conversations, mode, chatgpt } = selection;
  // A ChatGPT conversation's contents stay out: the owner reads them from `chatgpt` again.
  return ask(profileDirectory, 'import-start', JSON.stringify({ mode, chatgpt, conversations: conversations.map(({ exported: _, ...c }) => c) }));
}

/** Pauses the running import, resumes a paused or failed one, or discards a pending one, then reads the import back. With no Pi on the
 * profile, a discard happens here under the profile's lock, and a pause has nothing to pause. */
export async function controlImport(profileDirectory: string, action: 'pause' | 'resume' | 'discard') {
  if (action === 'discard') {
    const unlock = await lockProfile(profileDirectory, 'pi-optchat/files, discarding an import').catch((error: unknown) => {
      if (error instanceof ProfileBusyError) return undefined;
      throw error;
    });
    if (!unlock) return ask(profileDirectory, 'import-discard');
    try { discardImport(profileDirectory); } finally { await unlock(); }
    return readImport(profileDirectory);
  }
  // A holder that doesn't answer still counts as one.
  if (action === 'pause' && !await profileOwner(profileDirectory).catch(() => true)) return readImport(profileDirectory);
  return ask(profileDirectory, `import-${action}`);
}
