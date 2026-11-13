import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { KeybindingsManager } from '@earendil-works/pi-tui';
import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { CREATE_PROFILE } from '../src/menu.ts';
import { PROFILE_NAME } from '../src/profiles.ts';

// Every temp dir made through os.tmpdir() lands in this root, removed at exit. It also takes what a test's own cleanup misses: Pi rewrites auth.json after a test removed its dir, and a worker thread loads this file again but is terminated before 'exit'.
// macOS's default tmpdir is ~49 chars, and the extra level would push profile lock-socket paths past the 103-byte limit, so the outermost root goes under /tmp there. A child process or worker thread nests inside its parent's root, so it goes away with it even if it never reaches 'exit'.
const nested = basename(tmpdir()).startsWith('optchat-test-');
const root = mkdtempSync(join(process.platform === 'darwin' && !nested ? '/tmp' : tmpdir(), 'optchat-test-'));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = root;
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, so both are sandboxed: no test may touch the user's real ~/.optchat or ~/.pi.
for (const name of ['HOME', 'USERPROFILE', 'OPTCHAT_HOME', 'PI_CODING_AGENT_DIR']) process.env[name] = mkdtempSync(join(root, `optchat-${name.toLowerCase()}-`));
delete process.env.OPTCHAT_PROFILE; // a developer's own default would skip the pickers tests expect

/** Removes a test's temp dir. On Windows a process that just exited can hold its cwd a moment longer than `process.kill(pid, 0)` admits, so rmdir fails with EBUSY (#164). rmSync's own `maxRetries` doesn't cover that: it retries only after ENOTEMPTY, not a first rmdir that fails EBUSY. */
export function removeDir(path: string) {
  for (let attempt = 1; ; attempt++) {
    try { return rmSync(path, { recursive: true, force: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 10 || !(code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** A theme that keeps text as written, so a rendered line reads as the user sees it without colors. */
export const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** Pi's real matcher with delete at its default key, so Ctrl+D reaches a picker the way a terminal's bytes do in play. */
export const pickerKeys = new KeybindingsManager({ 'app.session.delete': { defaultKeys: 'ctrl+d' } });

/** What a picker is answered with: a profile to open, one to delete, or nothing to cancel. */
export type PickerAnswer = string | { delete: string } | undefined;
type PickerPage = { render: (width: number) => string[]; handleInput: (data: string) => void };

/** A profile picker row: a profile name or the create row, in the order the list shows them. */
const isRow = (label: string) => label === CREATE_PROFILE || PROFILE_NAME.test(label);
/** Where a rendered line's row starts, and what a selected row carries instead of the plain indent. */
const MARKER = /^[\u2192\u203a>]\s*/;
const rowOf = (line: string) => line.trim().replace(MARKER, '');

/** Answers OptChat's profile picker as a person would: records what it showed, walks to the answered row with `j`, then presses Enter, Ctrl+D or Escape. */
export function profilePickerAnswers(answers: PickerAnswer[], shown: string[][] = []): ExtensionUIContext['custom'] {
  return (async (factory: (tui: { requestRender: () => void }, theme: Theme, keys: unknown, done: (value: unknown) => void) => PickerPage) => new Promise((resolve, reject) => {
    const page = factory({ requestRender: () => {} }, plainTheme, pickerKeys, resolve);
    const lines = page.render(80).map(line => line.trimEnd());
    shown.push(lines);
    const answer = answers.shift();
    if (answer === undefined) return page.handleInput('\x1b');
    const wanted = typeof answer === 'string' ? answer : answer.delete;
    const rows = lines.map(rowOf).filter(isRow);
    if (!rows.includes(wanted)) return reject(new Error(`${wanted} is not on the picker`));
    // Walk until the marker sits on that row. Counting rendered rows would answer the wrong profile past the ten the list shows at once.
    const selected = () => { for (const line of page.render(80)) { const text = line.trim(); if (MARKER.test(text)) return rowOf(text); } return undefined; };
    for (let step = 0; step <= rows.length && selected() !== wanted; step++) page.handleInput('j');
    if (selected() !== wanted) return reject(new Error(`could not reach ${wanted} on the picker`));
    page.handleInput(typeof answer === 'string' ? '\u000d' : '\x04');
  })) as unknown as ExtensionUIContext['custom'];
}

process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY on Windows: leave it */ } });
