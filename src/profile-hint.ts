import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isKeyRelease, parseKey } from '@earendil-works/pi-tui';

/** A session's one-time picker hint. Observes typing without consuming or rewriting input. */
export class ProfileHint {
  private session?: string;
  private visible = false;
  private unsubscribe?: () => void;
  get suffix() { return this.visible ? ' · to switch: /optchat profile' : ''; }
  start(ctx: ExtensionContext, redraw: () => void) {
    const session = ctx.sessionManager.getSessionId();
    if (session === this.session) return;
    this.dispose(); this.session = session;
    if (ctx.mode !== 'tui' || ctx.ui.getEditorText()) return;
    this.visible = true;
    this.unsubscribe = ctx.ui.onTerminalInput(data => {
      const key = parseKey(data)?.replace(/^shift\+/, '');
      if (isKeyRelease(data) || !(data.startsWith('\x1b[200~') || data && !/[\x00-\x1f\x7f]/u.test(data)
        || key && ([...key].length === 1 || ['space', 'enter', 'ctrl+v', 'ctrl+y'].includes(key)))) return;
      this.dispose(); redraw();
      return undefined;
    });
  }
  dispose() { this.visible = false; this.unsubscribe?.(); this.unsubscribe = undefined; }
}
