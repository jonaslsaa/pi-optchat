import { getCurrentSystemMessage, getSystemMessageText, toToolDeclaration, type SystemMessage, type Tool } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { allowSearch, COMPACT, CONTINUITY, IMPORT_GUIDANCE, MASTER, SEARCH_DOC, VIEW_DOC } from './prompts.ts';
import type { Settings } from './settings.ts';

export interface RequestPrefix { system: SystemMessage; runtime: string }
type Policy = Pick<Settings, 'previousExchange' | 'memorySearch'>;
/** Turns and compactions have the same instructions; the task after the view selects the role. */
export const commonPrompt = ({ previousExchange = false, memorySearch = false }: Partial<Policy> = {}) =>
  allowSearch(`${MASTER}\n\n${VIEW_DOC}${previousExchange ? CONTINUITY : ''}${memorySearch ? SEARCH_DOC : ''}\n\n${COMPACT.slice(COMPACT.indexOf('# Compactions'))}`, memorySearch);

/** Known operational sections are request state. Project context, skills, MCP instructions and other sections remain intact. */
const RUNTIME_SECTIONS = new Set(['cwd', 'date', 'time', 'current_date', 'current_time', 'devices', 'runtime', 'optchat_status']);
export function requestPrefix(prompt: string | SystemMessage, instructions: string, policy: Policy, tools: readonly Tool[]): RequestPrefix {
  const runtime: string[] = [];
  let stable: string;
  if (typeof prompt === 'string') {
    // Before the first canonical request Pi exposes a rendered prompt. Match whole outer
    // sections so examples of <cwd> inside project context or skills stay instructions.
    stable = prompt.replace(/^<(\w+)>\n[\s\S]*?\n<\/\1>(?:\n\n|$)/gm, (section, name: string) => {
      if (!RUNTIME_SECTIONS.has(name)) return section;
      runtime.push(section.trimEnd()); return '';
    }).trim();
  } else {
    const sections = Object.fromEntries(Object.entries(prompt.sections ?? {}).filter(([name, content]) => {
      if (!RUNTIME_SECTIONS.has(name)) return true;
      if (content) runtime.push(content); return false;
    }));
    stable = getSystemMessageText({ ...prompt, sections }).trim();
  }
  return { system: { role: 'system', content: [commonPrompt(policy), stable, `<instructions>\n${instructions}\n\n${IMPORT_GUIDANCE}\n</instructions>`].filter(Boolean).join('\n\n'),
    toolsAdded: structuredClone(tools.map(toToolDeclaration)), timestamp: 0 }, runtime: runtime.join('\n\n') };
}

/** Capture complete declarations (including provider constraints), then prefer Pi's finalized request declarations.
 * Unchanged loadout notifications must not undo the finalized descriptions or hidden-declaration filtering. */
export class PrefixTools {
  private loadoutKey = '';
  private current: Tool[] = [];
  private promptKey = '';
  private canonical?: SystemMessage;
  loadout(tools: readonly Tool[]) {
    const declarations = tools.map(toToolDeclaration), key = JSON.stringify(declarations);
    if (key !== this.loadoutKey) { this.loadoutKey = key; this.current = declarations; }
  }
  finalize(messages: AgentMessage[], prompt: string) {
    this.canonical = getCurrentSystemMessage(messages);
    this.promptKey = prompt;
    this.current = this.canonical?.toolsAdded ?? [];
  }
  prompt(rendered: string) { return this.promptKey === rendered && this.canonical ? this.canonical : rendered; }
  snapshot() { return this.current.map(toToolDeclaration); }
}
