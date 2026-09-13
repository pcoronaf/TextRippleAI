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

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STANDALONE = path.join(ROOT, '.next', 'standalone');

const { extractZip } = require(path.join(ROOT, 'desktop', 'launcher.js'));
const { createZip, walk } = require(path.join(ROOT, 'desktop', 'zip-writer.js'));

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

/**
 * Find signtool.exe.
 *
 * It is part of the Windows SDK and is not on PATH on a GitHub runner, so fall
 * back to looking through the installed kits and taking the newest.
 */
function findSigntool() {
  const onPath = spawnSync('where', ['signtool'], { stdio: 'pipe' });
  if (onPath.status === 0) {
    const first = onPath.stdout.toString().split(/\r?\n/).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }

  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(kits)) return null;
  const candidates = fs
    .readdirSync(kits)
    .sort()
    .map((version) => path.join(kits, version, 'x64', 'signtool.exe'))
    .filter((candidate) => fs.existsSync(candidate));
  return candidates.at(-1) ?? null;
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
    // The official node.exe is signed, and injecting into it invalidates that
    // signature. A binary carrying a *corrupt* signature looks worse to
    // SmartScreen and to antivirus than an unsigned one, so remove it first.
    const signtool = findSigntool();
    if (signtool) {
      const removed = spawnSync(signtool, ['remove', '/s', exePath], { stdio: 'pipe' });
      console.log(
        removed.status === 0
          ? '   removed the Authenticode signature inherited from node.exe'
          : `   signtool could not remove the signature (exit ${removed.status}); continuing`,
      );
    } else {
      console.log('   no signtool found; the binary will keep an invalidated signature');
    }
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
