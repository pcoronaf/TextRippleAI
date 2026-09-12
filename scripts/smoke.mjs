#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server.
 *
 * Walks the M0/M1 workflow over HTTP - create, edit, record changes, checkpoint,
 * scope the ledger to that checkpoint, export - so the API, the store and the
 * format layer are verified together in a real Next.js runtime rather than only
 * as units.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import { createHash } from 'node:crypto';
import process from 'node:process';

const BASE = process.argv[2] ?? 'http://localhost:3000';

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  return response;
}

async function json(path, init) {
  const response = await api(path, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const hash = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const draft = (blockId, before, after, classification = 'editorial') => ({
  blockId,
  blockType: 'paragraph',
  operation: 'replace',
  before,
  after,
  beforeHash: hash(before),
  afterHash: hash(after),
  classification,
  sessionId: 'sess_smoke',
  occurredAt: new Date().toISOString(),
});

/** Replace the text of the block with the given id. */
function editBlock(content, blockId, text) {
  const next = structuredClone(content);
  for (const node of next.content) {
    if (node.attrs?.id === blockId) node.content = [{ type: 'text', text }];
  }
  return next;
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/ai/status`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not become ready at ${BASE}`);
}

async function main() {
  console.log(`Smoke testing ${BASE}`);
  await waitForServer();

  console.log('\nAI gateway');
  const status = await json('/api/ai/status');
  check('reports a selected provider', typeof status.selected === 'string', status.selected);
  check('lists all three adapters', status.providers?.length === 3);

  console.log('\nCreate and load');
  const created = await json('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Smoke manuscript',
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'The opening paragraph.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'The second paragraph.' }] },
        ],
      },
    }),
  });

  const id = created.document.id;
  check('document created at revision 1', created.document.currentRevision === 1);

  const blockIds = created.content.content.map((node) => node.attrs?.id);
  check('every block received a persistent ID', blockIds.every(Boolean), JSON.stringify(blockIds));
  check('IDs are unique', new Set(blockIds).size === blockIds.length);

  const loaded = await json(`/api/documents/${id}`);
  check(
    'reload preserves the same IDs',
    JSON.stringify(loaded.content.content.map((n) => n.attrs?.id)) === JSON.stringify(blockIds),
  );

  console.log('\nSave with a change');
  const target = blockIds[1];
  const saved = await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(loaded.content, target, 'The opening paragraph, revised.'),
      expectedRevision: 1,
      changes: [draft(target, 'The opening paragraph.', 'The opening paragraph, revised.')],
    }),
  });

  check('revision advanced to 2', saved.document.currentRevision === 2);
  check('one ledger entry written', saved.changes.length === 1);
  check('ledger entry is pending impact analysis', saved.changes[0]?.impactStatus === 'pending');
  check('ledger entry attributed to a human author', saved.changes[0]?.source === 'human');

  const stale = await api(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: loaded.content, expectedRevision: 1, changes: [] }),
  });
  check('a stale revision is rejected with 409', stale.status === 409, `got ${stale.status}`);

  console.log('\nCheckpoint');
  const checkpoint = await json(`/api/documents/${id}/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Methodology approved' }),
  });
  check('checkpoint pinned to revision 2', checkpoint.revision === 2);

  const sealed = await json(`/api/documents/${id}/changes`);
  check('earlier change sealed under the checkpoint', sealed.changes[0]?.checkpointId === checkpoint.id);

  console.log('\nChanges since the checkpoint');
  const afterCheckpoint = await json(`/api/documents/${id}`);
  await json(`/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: editBlock(afterCheckpoint.content, blockIds[2], 'The second paragraph, rewritten.'),
      expectedRevision: 2,
      changes: [
        draft(blockIds[2], 'The second paragraph.', 'The second paragraph, rewritten.'),
        draft(blockIds[2], 'spacing  here', 'spacing here', 'typographical'),
      ],
    }),
  });

  const all = await json(`/api/documents/${id}/changes`);
  check('ledger holds all three changes', all.changes.length === 3, `got ${all.changes.length}`);

  const since = await json(`/api/documents/${id}/changes?since=${checkpoint.id}`);
  check('two changes since the checkpoint', since.changes.length === 2, `got ${since.changes.length}`);
  check(
    'summary separates substantive from trivial',
    since.summary?.substantive === 1 && since.summary?.trivial === 1,
    JSON.stringify(since.summary),
  );
  check(
    'changes are attributed to a chapter',
    since.summary?.byChapter?.some((chapter) => chapter.title === 'Chapter One'),
    JSON.stringify(since.summary?.byChapter),
  );

  const substantive = await json(`/api/documents/${id}/changes?includeTrivial=false`);
  check(
    'typographical changes can be filtered out',
    substantive.changes.length === 2,
    `got ${substantive.changes.length}`,
  );

  console.log('\nExport');
  const docx = await api(`/api/documents/${id}/export?format=docx`);
  const bytes = new Uint8Array(await docx.arrayBuffer());
  check('DOCX export returns a zip container', bytes[0] === 0x50 && bytes[1] === 0x4b);
  check('DOCX export is not empty', bytes.length > 1000, `${bytes.length} bytes`);

  const markdown = await (await api(`/api/documents/${id}/export?format=md`)).text();
  check('Markdown export keeps the heading', markdown.includes('# Chapter One'));
  check('Markdown export keeps revised prose', markdown.includes('rewritten'));

  console.log('\nCleanup');
  const deleted = await api(`/api/documents/${id}`, { method: 'DELETE' });
  check('document deleted', deleted.status === 204);
  check('deleted document is gone', (await api(`/api/documents/${id}`)).status === 404);

  console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
