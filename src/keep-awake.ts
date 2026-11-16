import { spawn } from 'node:child_process';

/** How long the Mac stays awake after the last run ends, so back-to-back runs share one hold (as T3 Code does). */
export const AWAKE_GRACE = 60_000;
interface Hold { kill(): unknown; on(event: 'error' | 'exit', listener: () => void): unknown }
const caffeinate = (args: string[]): Hold => {
  const child = spawn('caffeinate', args, { stdio: 'ignore' });
  child.unref(); // Never keeps Pi alive; `-w` ends it with Pi.
  return child;
};

/**
 * Keeps a Mac out of idle sleep while this process has a run at work, and for `grace` after, with one `caffeinate` child that
 * `-w` ends if this process dies. Anywhere else, or when off, it holds nothing. `update` takes the current state on every change.
 */
export function keepAwake({ start = caffeinate, platform = process.platform, pid = process.pid, grace = AWAKE_GRACE } = {}) {
  let hold: Hold | undefined, timer: NodeJS.Timeout | undefined;
  const release = () => { clearTimeout(timer); timer = undefined; hold?.kill(); hold = undefined; };
  const update = (busy: boolean, enabled: boolean) => {
    if (platform !== 'darwin' || !enabled) return release();
    if (!busy) { if (hold) timer ??= setTimeout(release, grace).unref(); return; }
    clearTimeout(timer); timer = undefined;
    if (hold) return;
    const child = hold = start(['-i', '-w', String(pid)]);
    // Missing or killed from outside: the next busy update starts a new one.
    const gone = () => { if (hold === child) release(); };
    child.on('error', gone); child.on('exit', gone);
  };
  return { update, release };
}
