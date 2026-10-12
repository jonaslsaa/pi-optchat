import type { Context } from '@earendil-works/pi-ai';
import { textContent } from '../src/transcript.ts';

/** Roles share one system prefix. Synthetic providers distinguish them by the compaction task after the view. */
export const isCompaction = (context: Context) => context.messages.some(message => message.role === 'user'
  && textContent(message.content).includes('\n\nCompaction:'));
