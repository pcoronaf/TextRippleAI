import { describe, expect, it } from 'vitest';

import { clusterChanges, contentWords, wordShift } from '@/core/cluster';
import { contentHash } from '@/core/hash';
import type { ChangeClassification, ChangeRecord } from '@/core/types';

let counter = 0;

const change = (
  blockId: string,
  before: string,
  after: string,
  classification: ChangeClassification = 'terminology',
): ChangeRecord => ({
  id: `chg_${++counter}`,
  documentId: 'doc_1',
  blockId,
  blockType: 'paragraph',
  authorId: 'usr_test',
  source: 'human',
  operation: 'replace',
  classification,
  before,
  after,
  beforeHash: contentHash(before),
  afterHash: contentHash(after),
  sessionId: 'sess_1',
  revision: 2,
  checkpointId: null,
  impactStatus: 'pending',
  prompt: null,
  model: null,
  suggestionId: null,
  occurredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

describe('contentWords', () => {
  it('drops filler and duplicates', () => {
    expect(contentWords('The risk of the incident is a risk')).toEqual(['risk', 'incident']);
  });
});

describe('wordShift', () => {
  it('reports what a change took out and put in', () => {
    expect(wordShift('the probability of failure', 'the likelihood of failure')).toEqual({
      removed: ['probability'],
      added: ['likelihood'],
    });
  });

  it('ignores a word that merely moved', () => {
    // Reordering is not a vocabulary change.
    const shift = wordShift('oversight and review', 'review and oversight');
    expect(shift.removed).toEqual([]);
    expect(shift.added).toEqual([]);
  });

  it('reports a pure addition', () => {
    const shift = wordShift('systems require oversight', 'systems require meaningful oversight');
    expect(shift.added).toEqual(['meaningful']);
    expect(shift.removed).toEqual([]);
  });
});

describe('clusterChanges', () => {
  it('collapses one terminology sweep into a single conceptual change', () => {
    // The case the spec opens with: fifty small edits, one thing to reason about.
    const sweep = [
      change('p_1', 'the probability of an incident', 'the likelihood of an incident'),
      change('p_2', 'probability of failure is low', 'likelihood of failure is low'),
      change('p_3', 'estimates the probability precisely', 'estimates the likelihood precisely'),
    ];

    const clusters = clusterChanges(sweep);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
    expect(clusters[0].blockIds).toEqual(['p_1', 'p_2', 'p_3']);
    expect(clusters[0].terms.removed).toContain('probability');
    expect(clusters[0].terms.added).toContain('likelihood');
    expect(clusters[0].label).toContain('probability');
    expect(clusters[0].label).toContain('likelihood');
    expect(clusters[0].label).toContain('3 places');
  });

  it('keeps unrelated swaps apart', () => {
    const clusters = clusterChanges([
      change('p_1', 'the probability rises', 'the likelihood rises'),
      change('p_2', 'a mandatory review', 'an optional review'),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('groups repeated work on one passage', () => {
    const rewrite = [
      change(
        'p_9',
        'A long original sentence with a great many different words in it indeed.',
        'A completely different sentence saying something else entirely for other reasons.',
        'editorial',
      ),
      change(
        'p_9',
        'A completely different sentence saying something else entirely for other reasons.',
        'A third version, longer still, with yet more fresh vocabulary introduced throughout.',
        'editorial',
      ),
    ];

    const clusters = clusterChanges(rewrite);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(2);
    expect(clusters[0].label).toContain('2 edits');
  });

  it('excludes typographical noise by default', () => {
    const clusters = clusterChanges([
      change('p_1', 'spacing  here', 'spacing here', 'typographical'),
      change('p_2', 'the probability rises', 'the likelihood rises'),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].blockIds).toEqual(['p_2']);
  });

  it('can include trivial changes when asked', () => {
    const clusters = clusterChanges(
      [change('p_1', 'spacing  here', 'spacing here', 'typographical')],
      { includeTrivial: true },
    );

    expect(clusters).toHaveLength(1);
  });

  it('returns nothing for an empty ledger', () => {
    expect(clusterChanges([])).toEqual([]);
  });

  it('takes the dominant classification of its members', () => {
    const clusters = clusterChanges([
      change('p_1', 'the probability rises', 'the likelihood rises', 'terminology'),
      change('p_2', 'the probability falls', 'the likelihood falls', 'terminology'),
      change('p_3', 'the probability holds', 'the likelihood holds', 'style'),
    ]);

    expect(clusters[0].classification).toBe('terminology');
  });

  it('orders the largest conceptual change first', () => {
    const clusters = clusterChanges([
      change('p_1', 'a mandatory review', 'an optional review'),
      change('p_2', 'the probability rises', 'the likelihood rises'),
      change('p_3', 'the probability falls', 'the likelihood falls'),
    ]);

    expect(clusters[0].size).toBe(2);
  });

  it('carries the text as it now reads, for semantic retrieval', () => {
    const clusters = clusterChanges([
      change('p_1', 'the probability of an incident', 'the likelihood of an incident'),
    ]);

    expect(clusters[0].afterText).toEqual(['the likelihood of an incident']);
  });
});

describe('candidateLimitFor', () => {
  it('keeps the reduction target achievable at any document size', async () => {
    const { candidateLimitFor } = await import('@/server/impact');

    // A fixed cap would make the spec's >80% reduction an accident of length.
    for (const blocks of [60, 100, 500, 2000]) {
      const limit = candidateLimitFor(blocks);
      const reduction = (1 - limit / blocks) * 100;
      expect(reduction, `${blocks} blocks`).toBeGreaterThan(80);
    }
  });

  it('still bounds the reasoning call on an enormous corpus', async () => {
    const { candidateLimitFor } = await import('@/server/impact');
    // Raised from 30: on a book the ceiling was the only thing that ever bound,
    // so the shortlist ignored document size and the reduction figure described
    // the cap. A character budget now does the real bounding.
    expect(candidateLimitFor(100_000)).toBe(120);
  });

  it('does not cut a very short document to nothing', async () => {
    const { candidateLimitFor } = await import('@/server/impact');
    expect(candidateLimitFor(6)).toBe(8);
  });
});
