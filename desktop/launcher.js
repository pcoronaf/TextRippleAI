'use strict';
/**
 * Launcher for the packaged Windows build.
 *
 * This file is the entry point of a Node Single Executable Application: the
 * whole app is carried inside the .exe as a zipped asset, extracted once to
 * %LOCALAPPDATA% on first run, and then served by the Next.js standalone
 * server in this same process.
 *
 * Two constraints shape it:
 *
 *  1. A SEA entry point must be ONE file. Nothing here may require anything
 *     but node builtins - hence the hand-written zip reader below rather than
 *     a dependency.
 *  2. It must be testable without building an .exe, so the pieces are exported
 *     and `main()` runs only when this really is the packaged binary (or when
 *     TEXTRIPPLE_LAUNCHER_RUN is set, which is how the tests drive it).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

/** The port we prefer, so a second launch can find the first instead of racing it. */
const PREFERRED_PORT = 3717;
const HOST = '127.0.0.1';

// --- CRC-32 ----------------------------------------------------------------
// zlib.crc32 only exists from Node 22, and the exe should still run on an
// older runtime if one is ever used to build it. It is 20 lines; keep it.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** CRC-32 of a buffer, as an unsigned 32-bit number. */
function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Zip reading -----------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Locate the end-of-central-directory record.
 *
 * It sits at the very end of the file unless there is an archive comment, so
 * scan backwards over the largest comment the format allows.
 */
function findEndOfCentralDirectory(buffer) {
  const maxComment = 0xffff;
  const start = Math.max(0, buffer.length - (maxComment + 22));
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('Not a zip archive: no end-of-central-directory record.');
}

/** Read the central directory into a list of entry descriptors. */
function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error(`Corrupt zip: expected a central directory header at ${offset}.`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Resolve an entry name against the destination directory, refusing anything
 * that would escape it.
 *
 * An archive we built ourselves cannot contain such a name, but the archive
 * arrives inside a downloaded binary, and a zip reader that trusts its input
 * is how zip-slip happens.
 */
function safeJoin(destination, name) {
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`Refusing absolute path in archive: ${name}`);
  }
  const target = path.resolve(destination, name);
  const root = path.resolve(destination);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing path outside the destination: ${name}`);
  }
  return target;
}

/**
 * Extract every entry of `buffer` into `destination`.
 *
 * Returns the number of files written. Verifies each entry's CRC, so a
 * truncated or tampered download fails here rather than as a puzzling error
 * from the server three seconds later.
 */
function extractZip(buffer, destination) {
  const entries = readCentralDirectory(buffer);
  let written = 0;

  for (const entry of entries) {
    const target = safeJoin(destination, entry.name);

    if (entry.name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    if (buffer.readUInt32LE(entry.localOffset) !== SIG_LOCAL) {
      throw new Error(`Corrupt zip: no local header for ${entry.name}.`);
    }
    // The local header repeats the name and extra fields, and its extra field
    // length can differ from the central one - so read the lengths from here.
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(start, start + entry.compressedSize);

    let contents;
    if (entry.method === 0) {
      contents = Buffer.from(raw);
    } else if (entry.method === 8) {
      contents = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}.`);
    }

    if (contents.length !== entry.uncompressedSize) {
      throw new Error(`Corrupt zip: ${entry.name} has the wrong length.`);
    }
    if (crc32(contents) !== entry.crc) {
      throw new Error(`Corrupt zip: ${entry.name} failed its checksum.`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    written++;
  }

  return written;
}

// --- Installation ----------------------------------------------------------

/** Where the app unpacks to, and where documents are kept. */
function installRoot() {
  const base =
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'TextRippleAI');
}

/**
 * Unpack the app for this build if it is not already unpacked.
 *
 * Extraction goes to a temporary directory and is renamed into place, so an
 * interrupted first run leaves no half-unpacked directory that would be
 * mistaken for a good one on the next launch. The directory is named after the
 * build id, so a newer .exe unpacks alongside rather than over the old one.
 */
function ensureInstalled(zip, buildId, root) {
  const target = path.join(root, `app-${buildId}`);
  if (fs.existsSync(path.join(target, '.complete'))) return target;

  fs.rmSync(target, { recursive: true, force: true });
  const staging = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(staging, { recursive: true });

  try {
    const count = extractZip(zip, staging);
    fs.writeFileSync(path.join(staging, '.complete'), `${buildId}\n${count} files\n`);
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return target;
}

// --- Ports -----------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: HOST, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: HOST, exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Is the thing already on our preferred port one of our own instances? */
async function isOurServer(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/ai/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body === 'object' && body !== null && 'provider' in body;
  } catch {
    return false;
  }
}

// --- Browser ---------------------------------------------------------------

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // The empty argument is the window title `start` would otherwise take
      // the URL for.
      spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Not being able to open a browser is not a reason to refuse to serve.
  }
}

// --- Readiness -------------------------------------------------------------

async function waitForReady(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${HOST}:${port}/api/ai/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return true;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// --- Main ------------------------------------------------------------------

function readAssets() {
  // Only reachable inside the packaged binary.
  const sea = require('node:sea');
  return {
    zip: Buffer.from(sea.getRawAsset('app.zip')),
    buildId: Buffer.from(sea.getRawAsset('build-id')).toString('utf8').trim(),
  };
}

async function main(argv = process.argv.slice(2)) {
  const smoke = argv.includes('--smoke') || process.env.TEXTRIPPLE_SMOKE === '1';

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'TextRippleAI\n\n' +
        '  (no arguments)  unpack if needed, start the server, open a browser\n' +
        '  --smoke         start, verify the app answers, exit - used by CI\n' +
        '  --help          this message\n',
    );
    return 0;
  }

  const root = installRoot();
  const { zip, buildId } = readAssets();

  // If our preferred port is already serving this app, the user has it open
  // already. Show them that window rather than starting a second server on a
  // different port against the same documents.
  if (!smoke && !(await isPortFree(PREFERRED_PORT)) && (await isOurServer(PREFERRED_PORT))) {
    const url = `http://${HOST}:${PREFERRED_PORT}`;
    process.stdout.write(`TextRippleAI is already running at ${url}\n`);
    openBrowser(url);
    return 0;
  }

  process.stdout.write('Preparing TextRippleAI...\n');
  const appDir = ensureInstalled(zip, buildId, root);

  const port = (await isPortFree(PREFERRED_PORT)) ? PREFERRED_PORT : await findFreePort();
  const url = `http://${HOST}:${port}`;

  process.env.DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(port);
  process.env.HOSTNAME = HOST;

  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

  // The standalone server resolves its own dependencies relative to itself, so
  // load it through a require rooted in the unpacked directory rather than in
  // the executable.
  process.chdir(appDir);
  const requireFromApp = createRequire(path.join(appDir, 'launcher-anchor.js'));
  requireFromApp('./server.js');

  if (smoke) {
    const ready = await waitForReady(port);
    if (!ready) {
      process.stderr.write('FAIL server did not become ready\n');
      return 1;
    }
    process.stdout.write(`  ok   server ready at ${url}\n`);

    const documents = await fetch(`${url}/api/documents`);
    if (!documents.ok) {
      process.stderr.write(`FAIL GET /api/documents -> ${documents.status}\n`);
      return 1;
    }
    process.stdout.write('  ok   GET /api/documents\n');

    const home = await fetch(url);
    if (!home.ok) {
      process.stderr.write(`FAIL GET / -> ${home.status}\n`);
      return 1;
    }
    process.stdout.write('  ok   GET /\n');
    process.stdout.write(`  ok   unpacked to ${appDir}\n`);
    process.stdout.write('Packaged app started and answered.\n');
    return 0;
  }

  if (!(await waitForReady(port))) {
    process.stderr.write('TextRippleAI did not start. Nothing was changed.\n');
    return 1;
  }

  process.stdout.write(`TextRippleAI is running at ${url}\nDocuments: ${process.env.DATA_DIR}\n`);
  process.stdout.write('Close this window to stop it.\n');
  openBrowser(url);
  return null; // Keep serving.
}

function isPackaged() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

if (isPackaged() || process.env.TEXTRIPPLE_LAUNCHER_RUN === '1') {
  main().then(
    (code) => {
      if (code !== null) process.exit(code);
    },
    (error) => {
      process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
      process.exit(1);
    },
  );
}

module.exports = {
  crc32,
  extractZip,
  readCentralDirectory,
  safeJoin,
  ensureInstalled,
  installRoot,
  main,
};
