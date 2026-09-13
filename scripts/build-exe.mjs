#!/usr/bin/env node
/**
 * Build the single-file Windows executable.
 *
 * Run after `next build` (which, with `output: 'standalone'`, leaves a
 * self-contained server under .next/standalone):
 *
 *   npm run build
 *   node scripts/build-exe.mjs
 *
 * The result is dist/TextRippleAI.exe - a Node Single Executable Application
 * carrying the whole app as a zipped asset. There is no installer and nothing
 * to install: the exe unpacks itself to %LOCALAPPDATA% the first time it runs.
 *
 * The zip is written here and read back by desktop/launcher.js. Both ends
 * share the CRC implementation, and this script extracts what it just built
 * and compares it against the source tree before packaging - a corrupt archive
 * has to fail on the build machine, not on someone's desktop.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STANDALONE = path.join(ROOT, '.next', 'standalone');

const { crc32, extractZip } = require(path.join(ROOT, 'desktop', 'launcher.js'));

// --- Zip writing -----------------------------------------------------------
// Deliberately minimal: deflate or store, no zip64, no encryption. Timestamps
// are fixed so that the same input produces the same archive, which is what
// makes the build id a meaningful identity for the unpacked directory.

const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000;

/** Every file under `dir`, as paths relative to it, with forward slashes. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
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

// --- Build steps -----------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function copyDirectory(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

/**
 * `next build` leaves the static assets outside the standalone directory, and
 * the standalone server does not serve what is not next to it. Copying them in
 * is a documented, and easily forgotten, part of using this output mode.
 */
function assembleStandalone() {
  if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
    throw new Error(
      'No .next/standalone/server.js. Run `npm run build` first, with output: "standalone" in next.config.',
    );
  }
  copyDirectory(path.join(ROOT, '.next', 'static'), path.join(STANDALONE, '.next', 'static'));
  if (fs.existsSync(path.join(ROOT, 'public'))) {
    copyDirectory(path.join(ROOT, 'public'), path.join(STANDALONE, 'public'));
  }
}

/** Extract the archive we just built and compare it against the source tree. */
function verifyArchive(archive, sourceDir) {
  const scratch = path.join(DIST, 'verify');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  const written = extractZip(archive, scratch);
  const expected = walk(sourceDir);
  const actual = walk(scratch);

  if (written !== expected.length) {
    throw new Error(`Extracted ${written} files but the source has ${expected.length}.`);
  }
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error('Extracted file list does not match the source tree.');
  }
  for (const name of expected) {
    const a = sha256(fs.readFileSync(path.join(sourceDir, name)));
    const b = sha256(fs.readFileSync(path.join(scratch, name)));
    if (a !== b) throw new Error(`Round trip changed ${name}.`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  return expected.length;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited with ${result.status}.`);
}

/** Resolve postject's CLI without relying on npx being able to reach the network. */
function postjectCli() {
  // A package with an `exports` field can refuse to resolve its own
  // package.json, so fall back to where npm put it.
  let manifestPath;
  try {
    manifestPath = require.resolve('postject/package.json');
  } catch {
    manifestPath = path.join(ROOT, 'node_modules', 'postject', 'package.json');
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error('postject is not installed. Run `npm install` first.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.postject;
  if (!relative) throw new Error('postject does not declare a bin entry.');
  return path.join(path.dirname(manifestPath), relative);
}

function build() {
  fs.mkdirSync(DIST, { recursive: true });

  console.log('== assembling the standalone server ==');
  assembleStandalone();

  console.log('== packing the app ==');
  const { archive, fileCount } = createZip(STANDALONE);
  console.log(`   ${fileCount} files, ${mb(archive.length)} compressed`);

  console.log('== verifying the archive round-trips ==');
  const verified = verifyArchive(archive, STANDALONE);
  console.log(`   ${verified} files extracted and byte-identical`);

  const buildId = sha256(archive).slice(0, 16);
  fs.writeFileSync(path.join(DIST, 'app.zip'), archive);
  fs.writeFileSync(path.join(DIST, 'build-id.txt'), buildId);
  console.log(`   build id ${buildId}`);

  console.log('== preparing the SEA blob ==');
  const config = {
    main: 'desktop/launcher.js',
    output: 'dist/sea-prep.blob',
    disableExperimentalSEAWarning: true,
    assets: {
      'app.zip': 'dist/app.zip',
      'build-id': 'dist/build-id.txt',
    },
  };
  fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(config, null, 2));
  run(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], 'sea-config');

  const exeName = process.platform === 'win32' ? 'TextRippleAI.exe' : 'TextRippleAI';
  const exePath = path.join(DIST, exeName);
  console.log('== copying the node runtime ==');
  fs.copyFileSync(process.execPath, exePath);

  if (process.platform === 'win32') {
    // Injecting into a signed binary invalidates the signature, so drop it
    // first when the Windows SDK is around. Not fatal if it is not: an
    // unsigned-but-modified exe still runs.
    const removed = spawnSync('signtool', ['remove', '/s', exePath], { stdio: 'pipe' });
    console.log(
      removed.status === 0
        ? '   removed the existing Authenticode signature'
        : '   no signtool available; continuing with an invalidated signature',
    );
  }

  console.log('== injecting the blob ==');
  run(
    process.execPath,
    [
      postjectCli(),
      exePath,
      'NODE_SEA_BLOB',
      path.join(DIST, 'sea-prep.blob'),
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ],
    'postject',
  );

  fs.rmSync(path.join(DIST, 'sea-prep.blob'), { force: true });
  fs.rmSync(path.join(DIST, 'app.zip'), { force: true });

  const size = fs.statSync(exePath).size;
  console.log(`\nBuilt ${path.relative(ROOT, exePath)} - ${mb(size)}`);
  console.log('Run it with no arguments to start the app, or --smoke to check it boots.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  build();
}

export { createZip, walk };
