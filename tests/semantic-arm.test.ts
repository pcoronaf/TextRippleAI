import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { candidateLimitFor } from '@/server/impact';
import { resetCredentialSource } from '@/ai/credentials';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-arm-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const saved = { ...process.env };
beforeEach(() => {
  process.env.DATA_DIR = path.join(root, `run-${Math.random().toString(36).slice(2)}`);
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  process.env = { ...saved };
  resetCredentialSource();
});

describe('how many passages reach the model', () => {
  it('forwards a proportion of a short document, not half of it', () => {
    expect(candidateLimitFor(20)).toBe(8);
    expect(candidateLimitFor(100)).toBe(15);
  });

  it('gives a book more than a pamphlet', () => {
    // The old ceiling of 30 meant a 3515-block manuscript and a 200-block paper
    // got an identical shortlist, and "99.1% reduction" described the cap.
    expect(candidateLimitFor(3515)).toBe(120);
    expect(candidateLimitFor(400)).toBe(60);
    expect(candidateLimitFor(3515)).toBeGreaterThan(candidateLimitFor(400));
  });

});

describe('refusing an untrustworthy semantic arm', () => {
  it('refuses when the document has no embeddings at all', async () => {
    const { semanticArmFor } = await import('@/server/semantic-arm');
    const { getStore } = await import('@/store');

    const created = await getStore().createDocument({
      content: undefined,
      authorId: 'usr_test',
    });

    const arm = await semanticArmFor(created.document.id, 'anything');
    expect(arm.usable).toBe(false);
    if (!arm.usable) expect(arm.reason).toBe('not-indexed');
  });

  it('refuses a query with nothing in it', async () => {
    const { semanticArmFor } = await import('@/server/semantic-arm');
    const arm = await semanticArmFor('doc_whatever', '   ');
    expect(arm.usable).toBe(false);
    if (!arm.usable) expect(arm.reason).toBe('empty-query');
  });

  it('refuses hash-derived stub vectors rather than ranking by them', async () => {
    const { semanticArmFor } = await import('@/server/semantic-arm');
    const { getStore } = await import('@/store');
    const { flattenBlocks, ensureNodeIds } = await import('@/core/document');

    const store = getStore();
    const created = await store.createDocument({
      content: ensureNodeIds({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A paragraph.' }] }],
      }).content,
      authorId: 'usr_test',
    });
    const [block] = flattenBlocks(created.content);

    await store.upsertEmbeddings(created.document.id, [
      {
        nodeId: block.id,
        embeddingType: 'block',
        vector: [0.1, 0.2, 0.3],
        contentHash: 'sha256:x',
        sourceRevision: 1,
        provider: 'mock',
        model: 'mock-embedding-64',
      },
    ]);

    // The stub's vectors come from a SHA-256 digest, so similarity between them
    // is noise. Fusing that at any weight corrupts a shortlist silently.
    const arm = await semanticArmFor(created.document.id, 'a query');
    expect(arm.usable).toBe(false);
    if (!arm.usable) {
      expect(arm.reason).toBe('stub-vectors');
      expect(arm.detail).toMatch(/hash/i);
    }
  });

  it('refuses when the index was built by a different model', async () => {
    const { semanticArmFor } = await import('@/server/semantic-arm');
    const { getStore } = await import('@/store');
    const { flattenBlocks, ensureNodeIds } = await import('@/core/document');
    const { setCredentialSource } = await import('@/ai/credentials');

    const store = getStore();
    const created = await store.createDocument({
      content: ensureNodeIds({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A paragraph.' }] }],
      }).content,
      authorId: 'usr_test',
    });
    const [block] = flattenBlocks(created.content);

    await store.upsertEmbeddings(created.document.id, [
      {
        nodeId: block.id,
        embeddingType: 'block',
        vector: [0.1, 0.2, 0.3],
        contentHash: 'sha256:x',
        sourceRevision: 1,
        provider: 'openai',
        model: 'text-embedding-3-large',
      },
    ]);

    // Queries would be embedded by the stub, whose output is not comparable
    // with vectors from a real model - arithmetically valid, semantically void.
    setCredentialSource((name) => (name === 'AI_EMBEDDING_PROVIDER' ? 'mock' : undefined));

    const arm = await semanticArmFor(created.document.id, 'a query');
    expect(arm.usable).toBe(false);
    if (!arm.usable) expect(['stub-vectors', 'model-mismatch']).toContain(arm.reason);
  });
});
