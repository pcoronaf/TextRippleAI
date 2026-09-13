import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';

import { decodeImage, imageSize, parseDataUri } from '@/formats/image-data';
import { exportDocx } from '@/formats/docx';
import { ensureNodeIds } from '@/core/document';
import type { DocumentContent } from '@/core/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const launcher = require(path.join(here, '..', 'desktop', 'launcher.js'));

const scratch = mkdtempSync(path.join(tmpdir(), 'textripple-images-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A real 1x1 PNG - small enough to inline, valid enough for Word to accept. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, a JFIF APP0 that must be skipped, then the SOF0 carrying the size.
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF', 4, 'ascii');

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

describe('reading an image header', () => {
  it('measures a PNG', () => {
    expect(imageSize(png(800, 600))).toEqual({ format: 'png', width: 800, height: 600 });
  });

  it('measures a GIF', () => {
    expect(imageSize(gif(120, 80))).toEqual({ format: 'gif', width: 120, height: 80 });
  });

  it('measures a JPEG, skipping the segments before the frame', () => {
    expect(imageSize(jpeg(1024, 768))).toEqual({ format: 'jpg', width: 1024, height: 768 });
  });

  it('measures a BMP, including a top-down one with a negative height', () => {
    const buffer = Buffer.alloc(26);
    buffer.write('BM', 0, 'ascii');
    buffer.writeInt32LE(300, 18);
    buffer.writeInt32LE(-200, 22);
    expect(imageSize(buffer)).toEqual({ format: 'bmp', width: 300, height: 200 });
  });

  it('returns null for something it cannot read', () => {
    expect(imageSize(Buffer.from('this is not an image'))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});

describe('decoding an image node', () => {
  it('accepts a base64 data URI', () => {
    const decoded = decodeImage(dataUri('image/png', png(400, 300)));
    expect(decoded).toMatchObject({ format: 'png', width: 400, height: 300 });
  });

  it('scales an oversized image down, keeping its aspect ratio', () => {
    const decoded = decodeImage(dataUri('image/png', png(1800, 1200)));
    expect(decoded?.width).toBe(600);
    expect(decoded?.height).toBe(400);
  });

  it('believes the bytes over a mislabelled media type', () => {
    // A PNG announced as a JPEG is common, and Word reads the bytes.
    const decoded = decodeImage(dataUri('image/jpeg', png(40, 40)));
    expect(decoded?.format).toBe('png');
  });

  it('refuses a linked image, which has no bytes to embed', () => {
    expect(decodeImage('https://example.org/diagram.png')).toBeNull();
  });

  it('refuses a data URI whose payload is not an image we can measure', () => {
    expect(decodeImage('data:image/webp;base64,UklGRhoAAABXRUJQ')).toBeNull();
    expect(decodeImage('data:text/plain,hello')).toBeNull();
    expect(decodeImage('')).toBeNull();
    expect(decodeImage(undefined)).toBeNull();
  });

  it('parses a percent-encoded data URI as well as a base64 one', () => {
    expect(parseDataUri('data:text/plain,hello%20there')?.data.toString()).toBe('hello there');
  });
});

describe('images in an exported .docx', () => {
  const withImage = (): DocumentContent =>
    ensureNodeIds({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Figure 1 shows the architecture.' },
            { type: 'image', attrs: { src: `data:image/png;base64,${PNG_1X1}`, alt: 'Architecture' } },
          ],
        },
      ],
    }).content;

  it('writes the picture into the package rather than dropping it', async () => {
    const buffer = await exportDocx(withImage(), 'With an image');

    // A .docx is a zip, and the zip reader built for the packaged app can look
    // inside it - so this asserts the bytes really arrived, not merely that the
    // export did not throw.
    const destination = path.join(scratch, 'docx');
    rmSync(destination, { recursive: true, force: true });
    launcher.extractZip(buffer, destination);

    const media = readdirSync(path.join(destination, 'word', 'media'));
    expect(media.length).toBeGreaterThan(0);
  });

  it('falls back to alt text for an image it cannot embed', async () => {
    const linked = ensureNodeIds({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'https://example.org/a.png', alt: 'A remote chart' } },
          ],
        },
      ],
    }).content;

    const buffer = await exportDocx(linked, 'Linked image');
    const destination = path.join(scratch, 'docx-linked');
    rmSync(destination, { recursive: true, force: true });
    launcher.extractZip(buffer, destination);

    expect(readdirSync(path.join(destination, 'word'))).not.toContain('media');
  });
});
