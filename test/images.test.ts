import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { saveImages } from '../src/images.ts';
import { Memory, PAGE } from '../src/memory.ts';
import { memoryTools } from '../src/tools.ts';
import { logMessage, textContent } from '../src/transcript.ts';

/** An RGB PNG whose pixels come from `pixel`. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const image = (bytes: Buffer) => ({ type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/png' });

async function withMemory(run: (memory: Memory, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-images-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  try { await run(memory, dir); } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('an image is kept once, unchanged when small, and zoom(id, 1) returns it on the page that names it', () => withMemory(async (memory, dir) => {
  const small = image(png(4, 3, x => [x * 60, 0, 0]));
  const content = [{ type: 'text' as const, text: 'look' }, small, small];
  await saveImages(memory.store, content);
  await saveImages(memory.store, [small]);
  const files = readdirSync(join(dir, 'images'));
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(dir, 'images', files[0])).toString('base64'), small.data);
  memory.append('user', textContent(content));
  memory.append('user', 'x'.repeat(PAGE) + textContent([small]));
  const [zoom] = memoryTools(() => memory);
  const whole = await zoom.execute('call', { id: 0, n: 1 });
  assert.match(whole.content[0].type === 'text' ? whole.content[0].text : '', /^0\+0\|user: look\n\[image [0-9a-f]{16}\]\n\[image [0-9a-f]{16}\]$/);
  assert.deepEqual(whole.content.slice(1), [small]);
  assert.equal((await zoom.execute('call', { id: 1, n: 1 })).content.length, 1, 'the first page ends before the reference');
  assert.deepEqual((await zoom.execute('call', { id: 1, n: 1, offset: PAGE })).content.slice(1), [small]);
  // The zoom's echo names each image once, through its page, so memory never points at a copy.
  logMessage(memory, { role: 'toolResult', toolCallId: 'call', toolName: 'zoom', content: whole.content, isError: false, timestamp: 1 });
  assert.equal(memory.root[2].text.match(/\[image /g)?.length, 2);
}));

test('a large image is shrunk to 2048 px on its long side and about 1.5 MB', () => withMemory(async (memory, dir) => {
  await saveImages(memory.store, [image(png(4000, 3000, (x, y) => [x % 256, y % 256, 128]))]);
  let seed = 1;
  const noise = () => (seed = seed * 1103515245 + 12345 & 0x7fffffff) >> 23;
  await saveImages(memory.store, [image(png(2600, 1800, () => [noise(), noise(), noise()]))]);
  const [gradient, noisy] = readdirSync(join(dir, 'images')).map(file => ({ file, bytes: readFileSync(join(dir, 'images', file)) }))
    .sort((a, b) => a.bytes.length - b.bytes.length);
  assert.match(gradient.file, /\.png$/);
  assert.deepEqual([gradient.bytes.readUInt32BE(16), gradient.bytes.readUInt32BE(20)], [2048, 1536]);
  assert.match(noisy.file, /\.jpg$/);
  assert.ok(noisy.bytes.length <= 1.5 * 1024 * 1024, `${noisy.bytes.length} bytes`);
}));
