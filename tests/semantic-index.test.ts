import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import { FileStore } from '@/store';
import type { DocumentContent } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-index-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let store: FileStore;
beforeEach(() => {
  store = new FileStore(path.join(root, `run-${Math.random().toString(36).slice(2)}`));
});

const manuscript = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Governance' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Oversight' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Human oversight means review by a competent person before deployment.' },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Continuous monitoring runs after deployment.' }],
      },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'These rules apply to high-risk systems only.' }],
      },
    ],
  }).content;

async function seed() {
  const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
  const blocks = flattenBlocks(created.content);
  const byText = (text: string) => blocks.find((block) => block.text.startsWith(text))!;
  return { id: created.document.id, blocks, byText, content: created.content };
}

/** Deterministic stand-in for an embedding model. */
const fakeVector = (seed: number): number[] => [Math.cos(seed), Math.sin(seed), 0.5];

async function indexEverything(id: string, blocks: { id: string; text: string }[]) {
  for (const [index, block] of blocks.entries()) {
    await store.upsertEmbedding(id, {
      nodeId: block.id,
      embeddingType: 'block',
      vector: fakeVector(index),
      contentHash: contentHash(block.text),
      sourceRevision: 1,
      provider: 'mock',
      model: 'mock-embedding',
    });
  }
}

function edit(content: DocumentContent, blockId: string, text: string): DocumentContent {
  const next = JSON.parse(JSON.stringify(content)) as DocumentContent;
  for (const node of next.content) {
    if (node.attrs?.id === blockId) node.content = [{ type: 'text', text }];
  }
  return next;
}

describe('index freshness', () => {
  it('marks a changed block embedding stale and leaves the others current', async () => {
    const { id, blocks, byText, content } = await seed();
    await indexEverything(id, blocks);

    expect((await store.listEmbeddings(id, { statuses: ['current'] }))).toHaveLength(blocks.length);

    const target = byText('Human oversight means');
    await store.saveDocument(id, {
      content: edit(content, target.id, 'Human oversight means sign-off by an accountable person.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });

    const stale = await store.listEmbeddings(id, { statuses: ['stale'] });
    expect(stale.map((entry) => entry.nodeId)).toEqual([target.id]);
    expect(await store.listEmbeddings(id, { statuses: ['current'] })).toHaveLength(
      blocks.length - 1,
    );
  });

  it('makes the enclosing section stale and its chapter suspect', async () => {
    const { id, byText, content } = await seed();

    for (const [nodeId, type] of [
      [null, 'document'],
      [byText('Governance').id, 'chapter'],
      [byText('Oversight').id, 'section'],
      [byText('Scope').id, 'section'],
    ] as const) {
      await store.upsertSummary(id, {
        nodeId,
        summaryType: type,
        content: 'A brief.',
        sourceRevision: 1,
        provider: 'mock',
        model: 'mock-fast',
      });
    }

    const target = byText('Human oversight means');
    await store.saveDocument(id, {
      content: edit(content, target.id, 'Human oversight means sign-off by an accountable person.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });

    const summaries = await store.listSummaries(id);
    const status = (type: string, nodeId: string | null) =>
      summaries.find((entry) => entry.summaryType === type && entry.nodeId === nodeId)?.status;

    expect(status('section', byText('Oversight').id)).toBe('stale');
    expect(status('chapter', byText('Governance').id)).toBe('potentially_stale');
    expect(status('document', null)).toBe('potentially_stale');
    // An untouched sibling section is unaffected.
    expect(status('section', byText('Scope').id)).toBe('current');
  });

  it('regenerating clears the stale mark', async () => {
    const { id, byText, content } = await seed();
    await store.upsertSummary(id, {
      nodeId: byText('Oversight').id,
      summaryType: 'section',
      content: 'A brief.',
      sourceRevision: 1,
      provider: 'mock',
      model: 'mock-fast',
    });

    const target = byText('Human oversight means');
    await store.saveDocument(id, {
      content: edit(content, target.id, 'Rewritten.'),
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });
    expect((await store.listSummaries(id))[0].status).toBe('stale');

    await store.upsertSummary(id, {
      nodeId: byText('Oversight').id,
      summaryType: 'section',
      content: 'A fresher brief.',
      sourceRevision: 2,
      provider: 'mock',
      model: 'mock-fast',
    });

    const refreshed = await store.listSummaries(id);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].status).toBe('current');
    expect(refreshed[0].content).toBe('A fresher brief.');
  });

  it('discards artifacts belonging to a deleted block', async () => {
    const { id, blocks, byText, content } = await seed();
    await indexEverything(id, blocks);

    const target = byText('Continuous monitoring');
    const without = JSON.parse(JSON.stringify(content)) as DocumentContent;
    without.content = without.content.filter((node) => node.attrs?.id !== target.id);

    await store.saveDocument(id, {
      content: without,
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });

    const remaining = await store.listEmbeddings(id);
    expect(remaining.map((entry) => entry.nodeId)).not.toContain(target.id);
  });

  it('reports what is missing as well as what is stale', async () => {
    const { id, blocks } = await seed();
    const before = await store.indexStatus(id);

    expect(before.blocks).toBe(blocks.length);
    expect(before.embeddings.missing).toBe(blocks.length);
    expect(before.summaries.find((entry) => entry.type === 'section')?.missing).toBe(2);

    await indexEverything(id, blocks);
    const after = await store.indexStatus(id);
    expect(after.embeddings.missing).toBe(0);
    expect(after.embeddings.current).toBe(blocks.length);
  });
});

describe('semantic units', () => {
  it('replaces the units for one block without touching others', async () => {
    const { id, byText } = await seed();
    const a = byText('Human oversight means');
    const b = byText('Continuous monitoring');

    await store.replaceSemanticUnits(
      id,
      a.id,
      [{ type: 'definition', value: 'human oversight', context: a.text, rule: 'means' }],
      1,
    );
    await store.replaceSemanticUnits(
      id,
      b.id,
      [{ type: 'claim', value: b.text, context: b.text, rule: 'assertion' }],
      1,
    );

    expect(await store.listSemanticUnits(id)).toHaveLength(2);

    await store.replaceSemanticUnits(
      id,
      a.id,
      [{ type: 'definition', value: 'oversight', context: a.text, rule: 'means' }],
      2,
    );

    const units = await store.listSemanticUnits(id);
    expect(units).toHaveLength(2);
    expect(units.filter((unit) => unit.nodeId === a.id)).toHaveLength(1);
    expect(units.find((unit) => unit.nodeId === a.id)?.value).toBe('oversight');
  });

  it('filters by block and type', async () => {
    const { id, byText } = await seed();
    const a = byText('Human oversight means');

    await store.replaceSemanticUnits(
      id,
      a.id,
      [
        { type: 'definition', value: 'human oversight', context: a.text, rule: 'means' },
        { type: 'term', value: 'oversight', context: a.text, rule: 'quoted' },
      ],
      1,
    );

    expect(await store.listSemanticUnits(id, { types: ['definition'] })).toHaveLength(1);
    expect(await store.listSemanticUnits(id, { nodeIds: [a.id] })).toHaveLength(2);
  });
});

describe('retrieval primitives', () => {
  it('finds blocks containing the query terms', async () => {
    const { id, byText } = await seed();
    const hits = await store.searchText(id, 'continuous monitoring', 10);

    expect(hits[0].nodeId).toBe(byText('Continuous monitoring').id);
  });

  it('returns nothing for a query that matches no term', async () => {
    const { id } = await seed();
    expect(await store.searchText(id, 'zzzzz', 10)).toEqual([]);
  });

  it('ranks by vector similarity', async () => {
    const { id, blocks } = await seed();
    await indexEverything(id, blocks);

    // Ask for exactly the vector the third block was given.
    const hits = await store.searchVector(id, fakeVector(2), 3);
    expect(hits[0].nodeId).toBe(blocks[2].id);
    expect(hits[0].similarity).toBeCloseTo(1);
  });
});
