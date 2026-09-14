import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import { FileStore, RevisionConflictError } from '@/store';
import type { DocumentContent, DraftChange } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let store: FileStore;
beforeEach(() => {
  store = new FileStore(path.join(root, `run-${Math.random().toString(36).slice(2)}`));
});

const manuscript = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'The opening paragraph.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'The second paragraph.' }] },
    ],
  }).content;

const draft = (blockId: string, before: string, after: string): DraftChange => ({
  blockId,
  blockType: 'paragraph',
  operation: 'replace',
  before,
  after,
  beforeHash: contentHash(before),
  afterHash: contentHash(after),
  classification: 'editorial',
  sessionId: 'sess_test',
  occurredAt: new Date().toISOString(),
});

function edit(content: DocumentContent, blockId: string, text: string): DocumentContent {
  const next = JSON.parse(JSON.stringify(content)) as DocumentContent;
  for (const node of next.content) {
    if (node.attrs?.id === blockId) node.content = [{ type: 'text', text }];
  }
  return next;
}

describe('FileStore', () => {
  it('creates a document with persistent IDs and an initial version', async () => {
    const { document, content } = await store.createDocument({
      content: manuscript(),
      authorId: 'usr_test',
    });

    expect(document.currentRevision).toBe(1);
    expect(document.title).toBe('Chapter One');
    expect(flattenBlocks(content)).toHaveLength(3);
    expect(await store.listVersions(document.id)).toHaveLength(1);
  });

  it('round-trips content through close and reopen', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const reopened = await store.getDocument(created.document.id);

    expect(reopened?.content).toEqual(created.content);
    expect(flattenBlocks(reopened!.content).map((block) => block.id)).toEqual(
      flattenBlocks(created.content).map((block) => block.id),
    );
  });

  it('appends changes to the ledger when the document is saved', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const blocks = flattenBlocks(created.content);
    const target = blocks[1];

    const result = await store.saveDocument(created.document.id, {
      content: edit(created.content, target.id, 'The opening paragraph, revised.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [draft(target.id, target.text, 'The opening paragraph, revised.')],
    });

    expect(result.document.currentRevision).toBe(2);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      documentId: created.document.id,
      blockId: target.id,
      source: 'human',
      revision: 2,
      impactStatus: 'pending',
      checkpointId: null,
    });

    const ledger = await store.listChanges(created.document.id);
    expect(ledger).toHaveLength(1);
  });

  it('keeps an untouched node revision when its neighbour changes', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const blocks = flattenBlocks(created.content);

    await store.saveDocument(created.document.id, {
      content: edit(created.content, blocks[1].id, 'Rewritten.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [draft(blocks[1].id, blocks[1].text, 'Rewritten.')],
    });

    const nodes = await store.listNodes(created.document.id);
    const byId = new Map(nodes.map((node) => [node.id, node]));

    expect(byId.get(blocks[1].id)?.revision).toBe(2);
    expect(byId.get(blocks[2].id)?.revision).toBe(1);
  });

  it('rejects a save based on a stale revision', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });

    await expect(
      store.saveDocument(created.document.id, {
        content: created.content,
        expectedRevision: 99,
        authorId: 'usr_test',
        changes: [],
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('lists only the changes made since a checkpoint', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const id = created.document.id;
    const blocks = flattenBlocks(created.content);

    // Before the review boundary.
    const first = await store.saveDocument(id, {
      content: edit(created.content, blocks[1].id, 'Before checkpoint.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [draft(blocks[1].id, blocks[1].text, 'Before checkpoint.')],
    });

    const checkpoint = await store.createCheckpoint(id, {
      name: 'Methodology approved',
      createdBy: 'usr_test',
    });
    expect(checkpoint.revision).toBe(2);

    // After the review boundary.
    const current = await store.getDocument(id);
    await store.saveDocument(id, {
      content: edit(current!.content, blocks[2].id, 'After checkpoint.'),
      expectedRevision: first.document.currentRevision,
      authorId: 'usr_test',
      changes: [draft(blocks[2].id, blocks[2].text, 'After checkpoint.')],
    });

    expect(await store.listChanges(id)).toHaveLength(2);

    const since = await store.listChanges(id, { sinceCheckpointId: checkpoint.id });
    expect(since).toHaveLength(1);
    expect(since[0].after).toBe('After checkpoint.');
  });

  it('seals changes accumulated before a checkpoint', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const id = created.document.id;
    const blocks = flattenBlocks(created.content);

    await store.saveDocument(id, {
      content: edit(created.content, blocks[1].id, 'Sealed.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [draft(blocks[1].id, blocks[1].text, 'Sealed.')],
    });

    const checkpoint = await store.createCheckpoint(id, { name: 'Review', createdBy: 'usr_test' });
    const ledger = await store.listChanges(id);

    expect(ledger[0].checkpointId).toBe(checkpoint.id);
  });

  it('filters trivial changes on request', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const id = created.document.id;
    const blocks = flattenBlocks(created.content);

    await store.saveDocument(id, {
      content: edit(created.content, blocks[1].id, 'Two changes.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [
        { ...draft(blocks[1].id, 'a  b', 'a b'), classification: 'typographical' },
        draft(blocks[2].id, 'old', 'new'),
      ],
    });

    expect(await store.listChanges(id)).toHaveLength(2);
    expect(await store.listChanges(id, { includeTrivial: false })).toHaveLength(1);
  });

  it('serialises concurrent saves rather than losing one', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    const id = created.document.id;
    const blocks = flattenBlocks(created.content);

    const results = await Promise.allSettled([
      store.saveDocument(id, {
        content: edit(created.content, blocks[1].id, 'Writer A.'),
        expectedRevision: 1,
        authorId: 'usr_a',
        changes: [draft(blocks[1].id, blocks[1].text, 'Writer A.')],
      }),
      store.saveDocument(id, {
        content: edit(created.content, blocks[2].id, 'Writer B.'),
        expectedRevision: 1,
        authorId: 'usr_b',
        changes: [draft(blocks[2].id, blocks[2].text, 'Writer B.')],
      }),
    ]);

    // One save wins; the other is told its base revision is stale rather than
    // silently overwriting the first.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
  });

  it('deletes a document', async () => {
    const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
    await store.deleteDocument(created.document.id);
    expect(await store.getDocument(created.document.id)).toBeNull();
  });
});

describe('batched index writes', () => {
  it('writes many embeddings in one pass and reads them back', async () => {
    const created = await store.createDocument({
      content: ensureNodeIds({
        type: 'doc',
        content: Array.from({ length: 40 }, (_, i) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `Paragraph ${i} of the manuscript.` }],
        })),
      }).content,
      authorId: 'usr_test',
    });
    const blocks = flattenBlocks(created.content);

    const written = await store.upsertEmbeddings(
      created.document.id,
      blocks.map((block, i) => ({
        nodeId: block.id,
        embeddingType: 'block' as const,
        vector: [i / 100, 1 - i / 100, 0.5],
        contentHash: `sha256:${i}`,
        sourceRevision: 1,
        provider: 'mock',
        model: 'mock-embedding',
      })),
    );

    expect(written).toBe(blocks.length);
    const stored = await store.listEmbeddings(created.document.id);
    expect(stored).toHaveLength(blocks.length);
    expect(new Set(stored.map((entry) => entry.nodeId)).size).toBe(blocks.length);
  });

  it('replaces rather than duplicating when the same blocks are written again', async () => {
    const created = await store.createDocument({
      content: ensureNodeIds({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One paragraph.' }] }],
      }).content,
      authorId: 'usr_test',
    });
    const [block] = flattenBlocks(created.content);
    const input = {
      nodeId: block.id,
      embeddingType: 'block' as const,
      vector: [1, 0, 0],
      contentHash: 'sha256:first',
      sourceRevision: 1,
      provider: 'mock',
      model: 'mock-embedding',
    };

    await store.upsertEmbeddings(created.document.id, [input]);
    await store.upsertEmbeddings(created.document.id, [{ ...input, contentHash: 'sha256:second' }]);

    const stored = await store.listEmbeddings(created.document.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].contentHash).toBe('sha256:second');
  });

  it('replaces the units of many blocks at once', async () => {
    const created = await store.createDocument({
      content: ensureNodeIds({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'ISO/IEC 42001 is cited here.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'And ISO 9001 over here.' }] },
        ],
      }).content,
      authorId: 'usr_test',
    });
    const blocks = flattenBlocks(created.content);

    const first = await store.replaceSemanticUnitsFor(
      created.document.id,
      blocks.map((block) => ({
        nodeId: block.id,
        units: [{ type: 'citation' as const, value: `cite-${block.id}`, context: '', rule: 'test' }],
      })),
      1,
    );
    expect(first).toBe(2);

    // Writing again must replace, not accumulate.
    await store.replaceSemanticUnitsFor(
      created.document.id,
      blocks.map((block) => ({
        nodeId: block.id,
        units: [{ type: 'citation' as const, value: `again-${block.id}`, context: '', rule: 'test' }],
      })),
      2,
    );

    const units = await store.listSemanticUnits(created.document.id);
    expect(units).toHaveLength(2);
    expect(units.every((unit) => unit.value.startsWith('again-'))).toBe(true);
  });
});
