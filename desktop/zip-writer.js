'use strict';
/**
 * The other half of `launcher.js`'s zip reader: the writer the build uses to
 * pack the app into the executable.
 *
 * Deliberately minimal - deflate or store, no zip64, no encryption - and it
 * shares the reader's CRC implementation, so the two halves cannot drift apart
 * on the one field that would silently corrupt an archive.
 *
 * CommonJS, beside the reader, rather than living in the ESM build script: the
 * tests load it the same way the launcher is loaded, and importing a .mjs from
 * a TypeScript test needs a dynamic import that does not survive on Windows.
 *
 * Timestamps are fixed so the same input produces the same archive. That is
 * what makes the build id a meaningful identity for the unpacked directory
 * rather than something that changes on every build.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { crc32 } = require('./launcher.js');

const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000;

/** Every file under `dir`, as paths relative to it, with forward slashes. */
function walk(dir, prefix = '') {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      out.push(relative);
    }
    // Symlinks are skipped: the standalone output has none on Windows, and
    // silently following one would be worse than noticing its absence.
  }
  return out;
}

/** Build a zip archive of `sourceDir` in memory. */
function createZip(sourceDir) {
  const names = walk(sourceDir);
  if (names.length > 0xfffe) {
    throw new Error(`${names.length} files exceeds what a non-zip64 archive can address.`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of names) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const contents = fs.readFileSync(path.join(sourceDir, name));
    if (contents.length > 0xfffffffe) throw new Error(`${name} is too large for a non-zip64 archive.`);

    const deflated = zlib.deflateRawSync(contents, { level: 9 });
    // Storing is smaller than deflating for already-compressed files.
    const useDeflate = deflated.length < contents.length;
    const payload = useDeflate ? deflated : contents;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuffer, payload);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + payload.length;
    if (offset > 0xfffffffe) throw new Error('Archive exceeds 4 GB; zip64 would be required.');
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { archive: Buffer.concat([...locals, centralDirectory, eocd]), fileCount: names.length };
}

module.exports = { createZip, walk };
