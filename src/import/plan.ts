import { bytes } from '../core/memory.ts';
import { readMemory, type Memory } from '../memory.ts';
import { memoryDirectory } from '../profiles.ts';
import { record } from '../core/cache.ts';
import { readConversation, scanChatGPT, SOURCES, withNotes, type Conversation, type ImportedEntry } from './sources.ts';
import { deduplicate, type ImportMode } from './job.ts';

// What choosing an import computes, for Pi's terminal picker and for another app through pi-optchat/files. Pi-free.

/** What the chosen conversations, read in the order given, bring that memory doesn't have yet: `staged` is it with a note ahead of each
 * conversation (what an import stages), `added` its messages without the notes, `skipped` those memory has, `warnings` what couldn't be read. */
export async function select(memory: Memory, conversations: readonly Conversation[], signal?: AbortSignal, reading: (i: number, c: Conversation) => void = () => {}) {
  const entries: ImportedEntry[] = [], warnings: string[] = [];
  for (const [i, c] of conversations.entries()) {
    reading(i, c);
    const parsed = await readConversation(c, signal);
    // One at a time: a spread of a huge conversation would pass more arguments than a call takes.
    for (const entry of parsed.entries) entries.push(entry);
    for (const warning of parsed.warnings) warnings.push(warning);
  }
  const { added, skipped } = deduplicate(memory.entries(), entries);
  return { added: added.length, skipped, staged: withNotes(added), warnings };
}

export interface ImportEstimate { bytes: number; tokens: number; summaries: number }
/** The text an import indexes (rebuild indexes the existing log again), as rough source tokens, and up to how many new summary nodes it builds. */
export function estimate(memory: Memory, staged: readonly ImportedEntry[], mode: ImportMode): ImportEstimate {
  const affected = mode === 'rebuild' ? [...memory.entries(), ...staged] : staged;
  const size = affected.reduce((n, e) => n + bytes(e.text), 0);
  let summaries = 0;
  for (let n = memory.root.length + staged.length; n > 0; n = Math.floor(n / 2)) summaries += n;
  if (mode === 'append') summaries -= memory.tree.size;
  return { bytes: size, tokens: Math.ceil(size / 4), summaries };
}

/** What importing `conversations` into a profile would bring, for an app's footer before anything starts. Reads the profile's memory and the
 * sources, writes nothing. A big import costs about 3x `tokens` in compactor input (docs/import.md, Cost). */
export async function previewImport(profileDirectory: string, conversations: readonly Conversation[], signal?: AbortSignal) {
  const memory = await readMemory(memoryDirectory(profileDirectory));
  const { added, skipped, staged, warnings } = await select(memory, conversations, signal);
  return { conversations: conversations.length, added, skipped, warnings, memory: { messages: memory.root.length, summaries: memory.tree.size },
    append: estimate(memory, staged, 'append'), rebuild: estimate(memory, staged, 'rebuild') };
}
export type ImportPreview = Awaited<ReturnType<typeof previewImport>>;

/** An app's choice: conversations from one or several sources, in one run. `chatgpt` is the path `scanChatGPT` read, which the Pi that
 * runs the import reads again for the conversations' contents: they stay out of the request. */
export interface ImportSelection { conversations: Conversation[]; mode: ImportMode; chatgpt?: string }
const isConversation = (c: unknown): c is Conversation => record(c) && SOURCES.some(s => s === c.source)
  && ['id', 'file', 'title', 'project', 'date'].every(k => typeof c[k] === 'string') && Number.isSafeInteger(c.size);
/** An app's selection as the profile socket carries it, checked. */
export function parseSelection(text: string): ImportSelection {
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = undefined; }
  if (!record(value) || !Array.isArray(value.conversations) || !value.conversations.every(isConversation)
    || value.mode !== 'append' && value.mode !== 'rebuild' || value.chatgpt !== undefined && typeof value.chatgpt !== 'string') throw new Error('Invalid import selection');
  return { conversations: value.conversations.map(({ source, id, file, title, project, date, size }) => ({ source, id, file, title, project, date, size })),
    mode: value.mode, ...typeof value.chatgpt === 'string' && { chatgpt: value.chatgpt } };
}
/** What an app's selection stages in `memory`, as the terminal picker's would: refuses when nothing is new. ChatGPT conversations get
 * their contents from the export again; one no longer in it is left out. */
export async function stageSelection(memory: Memory, { conversations, mode, chatgpt }: ImportSelection, signal?: AbortSignal) {
  let chosen = conversations;
  if (chosen.some(c => c.source === 'chatgpt')) {
    if (!chatgpt) throw new Error('ChatGPT conversations need the export path they were scanned from.');
    const exported = new Map((await scanChatGPT(chatgpt, signal)).conversations.map(c => [c.id, c]));
    chosen = chosen.flatMap(c => c.source !== 'chatgpt' ? [c] : exported.get(c.id) ?? []);
  }
  const { added, skipped, staged } = await select(memory, chosen, signal);
  if (!added) throw new Error(`Nothing new to import (${skipped} messages already present).`);
  return { entries: staged, mode, skipped };
}
