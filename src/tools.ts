import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Memory } from './core/memory.ts';
import { memoryTools as tools } from './core/tools.ts';
import { runTranscript } from './transcript.ts';

/** zoom and date, where `runs` gives a subagent's messages by run id, live or finished; undefined for no such run. */
export const memoryTools = (memory: () => Memory, runs?: (id: string) => readonly AgentMessage[] | undefined) =>
  tools(memory, runs && (id => { const messages = runs(id); return messages && runTranscript(messages); }));
