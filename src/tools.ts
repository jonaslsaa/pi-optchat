import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { PAGE, type Memory } from './core/memory.ts';
import { memoryTools as tools, result, runPage } from './core/tools.ts';
import { RUN_ITEM_PAGE, runTranscript, runTranscriptItem } from './transcript.ts';

/** zoom and date, where `runs` gives a subagent's messages by run id, live or finished; undefined for no such run. */
export function memoryTools(memory: () => Memory, runs?: (id: string) => readonly AgentMessage[] | undefined) {
  const [zoom, date] = tools(memory, runs && (id => { const messages = runs(id); return messages && runTranscript(messages, id); }));
  if (!runs) return [zoom, date] as const;
  const parameters = Type.Object({ ...zoom.parameters.properties,
    item: Type.Optional(Type.Integer({ minimum: 1, description: 'For a run ID only: the item number in a clipped tool call/result\'s Read more call. Reads only that item; offset is a zero-based character position, limit defaults to 1,000 characters (maximum 25,000).' })) });
  return [{ ...zoom, parameters,
    description: zoom.description + ' Tool calls and results in the run overview keep about 1,000 characters each. Follow a Read more call to inspect only that item. Item reads return 1,000 characters by default; an explicit limit may request up to 25,000. Offset is zero-based within the item. Follow the complete continuation call to keep reading the same item.',
    async execute(id: string, args: Static<typeof parameters>) {
      if (args.item === undefined) return zoom.execute(id, args);
      if (typeof args.id !== 'string') throw new Error('item is only available with a subagent run ID.');
      const messages = runs(args.id);
      if (messages === undefined) throw new Error(`No run ${args.id}.`);
      if (args.n !== undefined) throw new Error('n selects memory tree lines; omit it when reading a run item.');
      const { offset = 0, limit = RUN_ITEM_PAGE } = args;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer.');
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer.');
      const pageSize = Math.min(limit, PAGE);
      return result(runPage(runTranscriptItem(messages, args.item), offset, pageSize,
        next => `continue with zoom(${JSON.stringify({ id: args.id, item: args.item, offset: next, limit: pageSize })})`));
    },
  }, date] as const;
}
