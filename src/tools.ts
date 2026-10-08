import { Type } from 'typebox';
import { flat, PAGE, start, type Memory } from './memory.ts';
import { loadImages } from './images.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export const SEARCH_PAGE = 20;
const SNIPPET = 200;
/** Added after the view doc when Memory search is on. */
export const SEARCH_DOC = '\n\nsearch(text) finds the original messages that contain text, newest first. Use it for an exact name, number, PR, path or error the view doesn\'t show, then zoom(id, 1) to read a hit. A hit is one message: zoom around it too, especially the messages after it, where the outcome usually is.';
const ZOOM_ONLY = 'zoom is your only\nallowed mechanism ', ZOOM_AND_SEARCH = 'zoom and search are your only\nallowed mechanisms ';
/** With Memory search on, the view doc allows search next to zoom; also turns a built prompt either way. */
export const allowSearch = (prompt: string, on: boolean) => on ? prompt.replace(ZOOM_ONLY, ZOOM_AND_SEARCH) : prompt.replace(ZOOM_AND_SEARCH, ZOOM_ONLY);

/** One page of hits, each with its id, the view line holding it, its date and a snippet around the first match; at most ~5 KB. */
export function searchPage(memory: Memory, text: string, before?: number) {
  const hits = memory.search(text, before), older = before === undefined ? '' : 'older ';
  if (!hits.length) return `No ${older}messages contain "${text}".`;
  const page = hits.slice(0, SEARCH_PAGE), needle = text.toLowerCase();
  const lines = page.map(entry => {
    // Cut the original text, whose match may span lines, and flatten only the cut.
    const at = Math.max(0, entry.text.toLowerCase().indexOf(needle) - SNIPPET / 4);
    const snippet = flat(entry.text.slice(at, at + SNIPPET).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, ''));
    // The live view, which may have folded since the turn's snapshot: its lines are built, so zoom always opens them.
    const line = memory.covering(entry.i); // Named only when the hit is inside a summary line.
    return `${entry.i}${line?.l ? ` (in ${start(line)}+${2 ** line.l})` : ''} · ${new Date(entry.date).toString().slice(0, 21)} · ${entry.kind}: ${at ? '…' : ''}${snippet}${at + SNIPPET < entry.text.length ? '…' : ''}`;
  });
  const more = hits.length > page.length ? `\nOlder matches: search again with before: ${page[page.length - 1].i}.` : '';
  return `${hits.length} ${older}${hits.length === 1 ? 'message contains' : 'messages contain'} "${text}", newest first:\n${lines.join('\n')}${more}`;
}

export function memoryTools(memory: () => Memory) {
  return [
    { name: 'zoom', label: 'Zoom memory', description: `Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. A message over ${PAGE.toLocaleString('en-US')} characters comes in pages; offset and limit (characters) read any part of it. A message's images come back with it.`,
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE })) }),
      async execute(_id: string, args: { id: number; n: number; offset?: number; limit?: number }) {
        const m = memory(), text = m.zoom(args.id, args.n, args.offset, args.limit), page = result(text);
        // A message's images come back with its text, as read returns a PNG; summaries stay text.
        return args.n === 1 ? { ...page, content: [...page.content, ...loadImages(m.directory, text)] } : page;
      } },
    { name: 'date', label: 'Memory date', description: 'The date and time of message id.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      async execute(_id: string, args: { id: number }) { return result(memory().date(args.id)); } },
  ];
}

export const searchTool = (memory: () => Memory) => ({ name: 'search', label: 'Search memory',
  description: `Find the original messages that contain text (plain text, any case), newest first, ${SEARCH_PAGE} at a time; before: id continues with older ones. zoom(id, 1) gives a hit whole.`,
  parameters: Type.Object({ text: Type.String({ minLength: 1 }), before: Type.Optional(Type.Integer({ minimum: 0 })) }),
  async execute(_id: string, args: { text: string; before?: number }) { return result(searchPage(memory(), args.text, args.before)); } });
