import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { atomicWrite } from './memory.ts';

/** Kept images fit 2048 px on the long side and ~1.5 MB (2 MB as base64), re-encoded as JPEG 85 only when they don't already. */
export const IMAGE_LIMITS = { maxWidth: 2048, maxHeight: 2048, maxBytes: 2 * 1024 * 1024, jpegQuality: 85 };
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
type Mime = keyof typeof EXTENSIONS;
const isMime = (mime: string): mime is Mime => Object.hasOwn(EXTENSIONS, mime);
const MIMES = new Map<string, Mime>((Object.keys(EXTENSIONS) as Mime[]).map(mime => [EXTENSIONS[mime], mime]));

const hash = (image: ImageContent) => createHash('sha256').update(image.data).digest('hex').slice(0, 16);
/** How a message's image reads in memory: named by the image as the message holds it, before any shrinking, so it always gets the same name. */
export const imageRef = (image: ImageContent) => `[image ${hash(image)}]`;
const REF = /\[image ([0-9a-f]{16})\]/g;

export const isImage = (part: unknown): part is ImageContent => typeof part === 'object' && part !== null
  && 'type' in part && part.type === 'image' && 'data' in part && typeof part.data === 'string' && 'mimeType' in part && typeof part.mimeType === 'string';
const stored = (directory: string, name: string) => {
  try { return readdirSync(join(directory, 'images')).find(file => file.startsWith(`${name}.`) && MIMES.has(file.slice(name.length + 1))); } catch { return undefined; }
};

/** Keeps each image of a message's content under `images/`, once per distinct image, shrunk to IMAGE_LIMITS. */
export async function saveImages(directory: string, content: unknown) {
  if (!Array.isArray(content)) return;
  for (const image of content.filter(isImage)) {
    const name = hash(image);
    if (stored(directory, name)) continue;
    // Pi's own resizer (Photon, WASM), as its read tool uses: it returns small images untouched, and null if it can't decode.
    const kept = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, IMAGE_LIMITS) ?? image;
    if (isMime(kept.mimeType)) atomicWrite(join(directory, 'images', `${name}.${EXTENSIONS[kept.mimeType]}`), Buffer.from(kept.data, 'base64'));
  }
}

/** The kept images a text refers to, in order, each once; ones never kept are skipped. */
export function loadImages(directory: string, text: string): ImageContent[] {
  return [...new Set(Array.from(text.matchAll(REF), match => match[1]))].flatMap(name => {
    const file = stored(directory, name), mimeType = file && MIMES.get(file.slice(name.length + 1));
    return file && mimeType ? [{ type: 'image' as const, data: readFileSync(join(directory, 'images', file)).toString('base64'), mimeType }] : [];
  });
}
