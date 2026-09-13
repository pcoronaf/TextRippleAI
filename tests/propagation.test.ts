import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { propagationContext, propagationInstruction } from '@/ai/propagation-prompt';
import { clusterChanges } from '@/core/cluster';
import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import { FileStore } from '@/store';
import type { DocumentContent, DraftChange, ImpactRecord } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-prop-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let store: FileStore;
beforeEach(() => {
  store = new FileStore(path.join(root, `run-${Math.random().toString(36).slice(2)}`));
});

const ORIGINAL = 'The probability of an incident is assessed annually.';
const REVISED = 'The likelihood of an incident is assessed annually.';
const DOWNSTREAM = 'Elsewhere the probability of failure is reported as low.';

const manuscript = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Risk' }] },
      { type: 'paragraph', content: [{ type: 'text', text: ORIGINAL }] },
      { type: 'paragraph', content: [{ type: 'text', text: DOWNSTREAM }] },
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
  classification: 'terminology',
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

/** Build the full chain: a change, an analysis that found a consequence. */
async function seedWithFinding() {
  const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
  const id = created.document.id;
  const blocks = flattenBlocks(created.content);

  const saved = await store.saveDocument(id, {
    content: edit(created.content, blocks[1].id, REVISED),
    expectedRevision: 1,
    authorId: 'usr_test',
    changes: [draft(blocks[1].id, ORIGINAL, REVISED)],
  });
  const originChange = saved.changes[0];

  const analysis = await store.createImpactAnalysis(id, {
    baseCheckpointId: null,
    targetRevision: 2,
    clusters: [
      {
        id: 'swap:probability=>likelihood',
        label: '"probability" → "likelihood"',
        classification: 'terminology',
        changeIds: [originChange.id],
        blockIds: [blocks[1].id],
        size: 1,
      },
    ],
    retrieval: { blocksInDocument: 3, candidatesConsidered: 1, reductionPercent: 66.7 },
    changesAnalysed: 1,
    changesFiltered: 0,
  });

  await store.completeImpactAnalysis(id, analysis.id, {
    status: 'completed',
    summary: 'One consequence.',
    provider: 'mock',
    model: 'mock-reasoning',
    inputTokens: 400,
    outputTokens: 60,
    impacts: [
      {
        sourceChangeIds: [originChange.id],
        sourceClusterId: 'swap:probability=>likelihood',
        targetBlockId: blocks[2].id,
        targetText: DOWNSTREAM,
        impactType: 'terminology_consistency',
        confidence: 0.9,
        severity: 'high',
        explanation: 'Still uses "probability" in the same sense the change moved away from.',
        recommendedAction: 'revise',
      },
    ],
  });

  const [impact] = await store.listImpacts(id, { analysisId: analysis.id });
  return { id, blocks, originChange, analysis, impact };
}

describe('propagation prompt', () => {
  const impact: ImpactRecord = {
    id: 'imp_1',
    impactAnalysisId: 'ia_1',
    documentId: 'doc_1',
    sourceChangeIds: ['chg_1'],
    sourceClusterId: 'swap:probability=>likelihood',
    targetBlockId: 'p_2',
    targetText: DOWNSTREAM,
    impactType: 'terminology_consistency',
    confidence: 0.9,
    severity: 'high',
    explanation: 'Still uses the superseded term.',
    recommendedAction: 'revise',
    status: 'pending',
    suggestionId: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
  };

  it('records why the edit is being asked for', () => {
    const instruction = propagationInstruction(impact);
    expect(instruction).toContain('terminology consistency');
    expect(instruction).toContain('Still uses the superseded term.');
  });

  it('tells the model what it is reconciling with', () => {
    const context = propagationContext({
      impact,
      clusters: clusterChanges([
        {
          id: 'chg_1',
          documentId: 'doc_1',
          blockId: 'p_1',
          blockType: 'paragraph',
          authorId: 'usr_test',
          source: 'human',
          operation: 'replace',
          classification: 'terminology',
          before: ORIGINAL,
          after: REVISED,
          beforeHash: contentHash(ORIGINAL),
          afterHash: contentHash(REVISED),
          sessionId: 'sess_1',
          revision: 2,
          checkpointId: null,
          impactStatus: 'pending',
          prompt: null,
          model: null,
          suggestionId: null,
          occurredAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]),
      originChangeSummaries: [{ before: ORIGINAL, after: REVISED }],
    });

    expect(context).toContain('probability');
    expect(context).toContain('likelihood');
    expect(context).toContain('high severity');
    expect(context).toContain('Still uses the superseded term.');
  });
});

describe('propagated proposals', () => {
  it('accepting one writes a propagation entry, not a plain AI edit', async () => {
    const { id, blocks, impact } = await seedWithFinding();

    const suggestion = await store.createSuggestion(id, {
      blockId: blocks[2].id,
      conversationId: null,
      instruction: propagationInstruction(impact),
      before: DOWNSTREAM,
      proposed: 'Elsewhere the likelihood of failure is reported as low.',
      rationale: 'Aligned the term with the change made earlier.',
      selectionStart: null,
      selectionEnd: null,
      provider: 'mock',
      model: 'mock-reasoning',
      inputTokens: 300,
      outputTokens: 40,
      contextDigest: null,
      parentSuggestionId: null,
      sourceImpactId: impact.id,
      baseRevision: 2,
    });

    const { change } = await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 2,
    });

    expect(change.source).toBe('propagation');
    expect(change.suggestionId).toBe(suggestion.id);
    // A propagated change is itself analysable: the ripple can continue.
    expect(change.impactStatus).toBe('pending');
  });

  it('an ordinary AI edit is still marked ai_accepted', async () => {
    const { id, blocks } = await seedWithFinding();

    const suggestion = await store.createSuggestion(id, {
      blockId: blocks[2].id,
      conversationId: null,
      instruction: 'Tighten this.',
      before: DOWNSTREAM,
      proposed: 'Failure is reported as unlikely.',
      rationale: 'Shorter.',
      selectionStart: null,
      selectionEnd: null,
      provider: 'mock',
      model: 'mock-reasoning',
      inputTokens: 100,
      outputTokens: 20,
      contextDigest: null,
      parentSuggestionId: null,
      sourceImpactId: null,
      baseRevision: 2,
    });

    const { change } = await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 2,
    });

    expect(change.source).toBe('ai_accepted');
  });

  it('traces a downstream change back to the change that caused it', async () => {
    const { traceChange } = await import('@/server/propagate');
    const { id, blocks, originChange, impact, analysis } = await seedWithFinding();

    const suggestion = await store.createSuggestion(id, {
      blockId: blocks[2].id,
      conversationId: null,
      instruction: propagationInstruction(impact),
      before: DOWNSTREAM,
      proposed: 'Elsewhere the likelihood of failure is reported as low.',
      rationale: 'Aligned the term.',
      selectionStart: null,
      selectionEnd: null,
      provider: 'mock',
      model: 'mock-reasoning',
      inputTokens: 300,
      outputTokens: 40,
      contextDigest: null,
      parentSuggestionId: null,
      sourceImpactId: impact.id,
      baseRevision: 2,
    });

    const { change } = await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 2,
    });

    // The acceptance criterion: every hop is a stored link, not an inference.
    const trace = await traceChange(id, change.id);

    expect(trace?.change.id).toBe(change.id);
    expect(trace?.suggestion?.id).toBe(suggestion.id);
    expect(trace?.impact?.id).toBe(impact.id);
    expect(trace?.analysis?.id).toBe(analysis.id);
    expect(trace?.originChanges.map((entry) => entry.id)).toEqual([originChange.id]);
    expect(trace?.originChanges[0].before).toBe(ORIGINAL);
  });

  it('traces an ordinary manual change to a short chain rather than failing', async () => {
    const { traceChange } = await import('@/server/propagate');
    const { id, originChange } = await seedWithFinding();

    const trace = await traceChange(id, originChange.id);

    expect(trace?.change.id).toBe(originChange.id);
    expect(trace?.suggestion).toBeNull();
    expect(trace?.impact).toBeNull();
    expect(trace?.originChanges).toEqual([]);
  });

  it('returns nothing for a change that does not exist', async () => {
    const { traceChange } = await import('@/server/propagate');
    const { id } = await seedWithFinding();

    expect(await traceChange(id, 'chg_missing')).toBeNull();
  });
});
