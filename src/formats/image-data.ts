/**
 * Just enough image handling to embed a picture in a .docx.
 *
 * Word needs the bytes and a size in the document, and an image node carries a
 * data URI and nothing else. Reading a PNG/JPEG/GIF header is a few dozen
 * lines; pulling in an image library for it would add a dependency to a layer
 * that has none, and the packaged build is deliberately pure JavaScript.
 *
 * Anything not recognised falls back to alt text, which is what happened to
 * every image before this existed.
 */

export type ImageFormat = 'png' | 'jpg' | 'gif' | 'bmp';

export interface DecodedImage {
  format: ImageFormat;
  data: Buffer;
  width: number;
  height: number;
}

/** Widest an image is rendered in the document, in pixels, before scaling down. */
const MAX_WIDTH = 600;

/** Split a `data:` URI into its media type and bytes. Returns null for anything else. */
export function parseDataUri(src: string): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(src.trim());
  if (!match) return null;

  const [, mime, parameters, payload] = match;
  const isBase64 = (parameters ?? '').includes(';base64');

  try {
    const data = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return data.length > 0 ? { mime: mime.toLowerCase(), data } : null;
  } catch {
    return null;
  }
}

/** Pixel dimensions read from the file header, or null if the format is not one we read. */
export function imageSize(data: Buffer): { format: ImageFormat; width: number; height: number } | null {
  // PNG: an 8-byte signature, then IHDR carrying width and height big-endian.
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then the logical screen size little-endian.
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }

  // BMP: "BM", then the DIB header's signed dimensions (height is negative for
  // a top-down bitmap).
  if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM') {
    return { format: 'bmp', width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
  }

  // JPEG: walk the segment markers to the start-of-frame, which is the only
  // place the dimensions are recorded.
  if (data.length >= 4 && data.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1];
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = data.readUInt16BE(offset + 2);
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isStartOfFrame) {
        return { format: 'jpg', width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}

/**
 * Decode an image node's `src` into bytes and a display size.
 *
 * Returns null when the image is linked rather than embedded, when the format
 * is not one we can measure, or when the header is damaged - in every case the
 * caller falls back to alt text rather than writing a broken picture.
 */
export function decodeImage(src: unknown): DecodedImage | null {
  if (typeof src !== 'string') return null;

  const parsed = parseDataUri(src);
  if (!parsed) return null;

  // The header decides the format, not the media type: a mislabelled data URI
  // is common, and the bytes are what Word has to read.
  const measured = imageSize(parsed.data);
  if (!measured || measured.width <= 0 || measured.height <= 0) return null;

  const scale = measured.width > MAX_WIDTH ? MAX_WIDTH / measured.width : 1;
  return {
    format: measured.format,
    data: parsed.data,
    width: Math.round(measured.width * scale),
    height: Math.max(1, Math.round(measured.height * scale)),
  };
}
