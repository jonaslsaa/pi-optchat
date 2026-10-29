/** Terminal tab titles: `● π personal · 2 agents` in the main window, `● ↳ personal` in a connected window. */
export type StatusState = 'waiting' | 'working';
export type WindowState = StatusState | 'done' | 'disconnected';

const agents = (count: number) => count > 0 ? ` · ${count} ${count === 1 ? 'agent' : 'agents'}` : '';
export const mainTitle = (profile: string, working: boolean, running: number) => `${working ? '● ' : ''}π ${profile}${agents(running)}`;
/** `label`: the spawn title of the subagent an attached window shows. */
export const windowTitle = (profile: string, state: WindowState, label?: string) =>
  `${state === 'working' ? '● ' : ''}↳ ${profile}${label ? ` · ${label}` : ''}${state === 'done' || state === 'disconnected' ? ` · ${state}` : ''}`;
/** A connected window's agent is working while it runs or stops, or waits on agents of its own; waiting with none means waiting for you. */
export const statusState = (state: string, agents = 0): StatusState =>
  state === 'running' || state === 'stopping' || state === 'waiting' && agents > 0 ? 'working' : 'waiting';

/**
 * Pi writes its own "π - <cwd>" title after binding a session (startup, reload, profile switch) and on
 * session renames, so the last title is kept and re-applied at those points.
 */
export class TabTitle {
  private title: string | undefined;
  private set: ((title: string) => void) | undefined;
  show(set: (title: string) => void, title: string) {
    this.set = set;
    if (title === this.title) return;
    this.title = title; this.apply();
  }
  reapply() { this.apply(); }
  clear() { this.title = undefined; this.set = undefined; }
  private apply() {
    if (!this.title || !this.set) return;
    try { this.set(this.title); } catch { /* A ctx captured before a session replacement is stale; the next session sets its own. */ }
  }
}
