import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Both halves of the zip handling are plain CommonJS with no dependencies -
// the reader because a SEA entry point must be a single self-contained file,
// the writer so that it can be loaded the same way here. `tsc` has no
// declarations for either, which `createRequire` sidesteps without the dynamic
// import that a TypeScript file would otherwise need.
const launcher = require(path.join(here, '..', 'desktop', 'launcher.js'));
const { createZip } = require(path.join(here, '..', 'desktop', 'zip-writer.js'));

const root = mkdtempSync(path.join(tmpdir(), 'textripple-package-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function scratch(): string {
  const dir = path.join(root, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A small tree standing in for the standalone server directory. */
function sampleTree(): string {
  const source = scratch();
  mkdirSync(path.join(source, 'node_modules', 'next'), { recursive: true });
  mkdirSync(path.join(source, '.next', 'static'), { recursive: true });

  writeFileSync(path.join(source, 'server.js'), 'console.log("serving");\n');
  writeFileSync(path.join(source, 'node_modules', 'next', 'index.js'), 'x'.repeat(10_000));
  writeFileSync(path.join(source, '.next', 'static', 'empty.txt'), '');
  writeFileSync(path.join(source, '.next', 'static', 'bytes.bin'), Buffer.from([0, 1, 2, 255, 254, 0]));
  writeFileSync(path.join(source, 'café.txt'), 'unicode name, unicode content: ré-entrant\n');
  return source;
}

describe('the archive carried inside the executable', () => {
  it('round-trips a directory tree byte for byte', () => {
    const source = sampleTree();
    const destination = scratch();

    const { archive, fileCount } = createZip(source);
    const written = launcher.extractZip(archive, destination);

    expect(fileCount).toBe(5);
    expect(written).toBe(5);
    expect(readFileSync(path.join(destination, 'server.js'), 'utf8')).toBe('console.log("serving");\n');
    expect(readFileSync(path.join(destination, 'node_modules', 'next', 'index.js'), 'utf8')).toHaveLength(10_000);
    expect(readFileSync(path.join(destination, '.next', 'static', 'empty.txt'))).toHaveLength(0);
    expect([...readFileSync(path.join(destination, '.next', 'static', 'bytes.bin'))]).toEqual([0, 1, 2, 255, 254, 0]);
    expect(readFileSync(path.join(destination, 'café.txt'), 'utf8')).toContain('ré-entrant');
  });

  it('stores incompressible data rather than growing it', () => {
    const source = scratch();
    const noise = randomBytes(4096);
    writeFileSync(path.join(source, 'noise.bin'), noise);

    const { archive } = createZip(source);
    const [entry] = launcher.readCentralDirectory(archive);

    expect(entry.method).toBe(0);
    expect(entry.compressedSize).toBe(noise.length);

    const destination = scratch();
    launcher.extractZip(archive, destination);
    expect(readFileSync(path.join(destination, 'noise.bin')).equals(noise)).toBe(true);
  });

  it('refuses an entry that would escape the destination', () => {
    // The archive ships inside a downloaded binary. A reader that trusts its
    // input is how a packaged app overwrites files it was never meant to.
    expect(() => launcher.safeJoin('/app', '../evil.txt')).toThrow(/outside the destination/);
    expect(() => launcher.safeJoin('/app', 'nested/../../evil.txt')).toThrow(/outside the destination/);
    expect(() => launcher.safeJoin('/app', 'C:\\Windows\\evil.txt')).toThrow(/absolute path/);

    expect(launcher.safeJoin('/app', 'nested/fine.txt')).toBe(path.resolve('/app', 'nested/fine.txt'));
  });

  it('detects a corrupted payload instead of unpacking it', () => {
    const source = scratch();
    // Random data cannot be deflated, so it is stored - which puts the bytes
    // flipped below squarely in the payload rather than in a deflate stream.
    const noise = randomBytes(2048);
    writeFileSync(path.join(source, 'noise.bin'), noise);

    const { archive } = createZip(source);
    const payloadStart = 30 + Buffer.from('noise.bin').length;
    archive[payloadStart + 100] ^= 0xff;

    expect(() => launcher.extractZip(archive, scratch())).toThrow(/checksum/);
  });

  it('rejects something that is not an archive at all', () => {
    expect(() => launcher.extractZip(Buffer.from('not a zip file, just some bytes'), scratch())).toThrow(
      /Not a zip archive/,
    );
  });
});

describe('unpacking on first run', () => {
  it('extracts once and then leaves the installation alone', () => {
    const source = sampleTree();
    const { archive } = createZip(source);
    const installRoot = scratch();

    const first = launcher.ensureInstalled(archive, 'build0001', installRoot);
    expect(existsSync(path.join(first, '.complete'))).toBe(true);
    expect(readFileSync(path.join(first, 'server.js'), 'utf8')).toContain('serving');

    // A second launch must not pay the extraction cost again - proven by the
    // edit surviving rather than being overwritten.
    writeFileSync(path.join(first, 'server.js'), 'edited');
    const second = launcher.ensureInstalled(archive, 'build0001', installRoot);

    expect(second).toBe(first);
    expect(readFileSync(path.join(second, 'server.js'), 'utf8')).toBe('edited');
  });

  it('unpacks a new build beside the old one', () => {
    const { archive } = createZip(sampleTree());
    const installRoot = scratch();

    const older = launcher.ensureInstalled(archive, 'build0001', installRoot);
    const newer = launcher.ensureInstalled(archive, 'build0002', installRoot);

    expect(newer).not.toBe(older);
    expect(existsSync(path.join(older, '.complete'))).toBe(true);
    expect(existsSync(path.join(newer, '.complete'))).toBe(true);
  });

  it('re-extracts when a previous attempt was interrupted', () => {
    const { archive } = createZip(sampleTree());
    const installRoot = scratch();

    const target = launcher.ensureInstalled(archive, 'build0001', installRoot);
    // What an interrupted first run leaves behind: files, but no marker.
    rmSync(path.join(target, '.complete'));
    writeFileSync(path.join(target, 'server.js'), 'half-written');

    launcher.ensureInstalled(archive, 'build0001', installRoot);
    expect(readFileSync(path.join(target, 'server.js'), 'utf8')).toContain('serving');
  });

  it('does not leave a staging directory behind when extraction fails', () => {
    const installRoot = scratch();
    const damaged = Buffer.from('this is not an archive');

    expect(() => launcher.ensureInstalled(damaged, 'build0003', installRoot)).toThrow();
    expect(readdirSync(installRoot)).toEqual([]);
  });
});
