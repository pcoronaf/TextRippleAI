import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import { FileStore, ImpactNotFoundError } from '@/store';
import type { DocumentContent, DraftChange } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-impact-'));
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
      { type: 'paragraph', content: [{ type: 'text', text: 'The probability of an incident.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Elsewhere, probability again.' }] },
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

async function seed() {
  const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
  const blocks = flattenBlocks(created.content);
  return { id: created.document.id, blocks, content: created.content };
}

async function analysisWithOneFinding(id: string, blocks: { id: string }[]) {
  const analysis = await store.createImpactAnalysis(id, {
    baseCheckpointId: null,
    targetRevision: 1,
    clusters: [
      {
        id: 'swap:probability=>likelihood',
        label: '"probability" → "likelihood"',
        classification: 'terminology',
        changeIds: ['chg_1'],
        blockIds: [blocks[1].id],
        size: 1,
      },
    ],
    retrieval: { blocksInDocument: 3, candidatesConsidered: 1, reductionPercent: 66.7 },
    changesAnalysed: 1,
    changesFiltered: 2,
  });

  await store.completeImpactAnalysis(id, analysis.id, {
    status: 'completed',
    summary: 'One consequence found.',
    provider: 'mock',
    model: 'mock-reasoning',
    inputTokens: 500,
    outputTokens: 80,
    impacts: [
      {
        sourceChangeIds: ['chg_1'],
        sourceClusterId: 'swap:probability=>likelihood',
        targetBlockId: blocks[2].id,
        targetText: 'Elsewhere, probability again.',
        impactType: 'terminology_consistency',
        confidence: 0.88,
        severity: 'high',
        explanation: 'Still uses the term the change moved away from.',
        recommendedAction: 'revise',
      },
    ],
  });

  return analysis.id;
}

describe('impact analysis persistence', () => {
  it('records a briefing with its findings', async () => {
    const { id, blocks } = await seed();
    const analysisId = await analysisWithOneFinding(id, blocks);

    const found = await store.getImpactAnalysis(id, analysisId);

    expect(found?.analysis.status).toBe('completed');
    expect(found?.analysis.summary).toBe('One consequence found.');
    expect(found?.analysis.changesFiltered).toBe(2);
    expect(found?.analysis.retrieval.reductionPercent).toBeCloseTo(66.7);
    expect(found?.analysis.model).toBe('mock-reasoning');

    expect(found?.impacts).toHaveLength(1);
    expect(found?.impacts[0]).toMatchObject({
      targetBlockId: blocks[2].id,
      severity: 'high',
      recommendedAction: 'revise',
      status: 'pending',
      suggestionId: null,
    });
  });

  it('keeps the conceptual changes so a briefing can be re-read', async () => {
    const { id, blocks } = await seed();
    const analysisId = await analysisWithOneFinding(id, blocks);

    const found = await store.getImpactAnalysis(id, analysisId);
    expect(found?.analysis.clusters[0].label).toContain('probability');
  });

  it('does not touch the document', async () => {
    const { id, blocks, content } = await seed();
    await analysisWithOneFinding(id, blocks);

    // The defining property of the whole milestone.
    const after = await store.getDocument(id);
    expect(after?.content).toEqual(content);
    expect(after?.document.currentRevision).toBe(1);
    expect(await store.listChanges(id)).toHaveLength(0);
  });

  it('resolves a finding and keeps it as review history', async () => {
    const { id, blocks } = await seed();
    const analysisId = await analysisWithOneFinding(id, blocks);
    const [impact] = await store.listImpacts(id, { analysisId });

    const dismissed = await store.setImpactStatus(id, impact.id, {
      status: 'dismissed',
      resolvedBy: 'usr_test',
    });

    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.resolvedBy).toBe('usr_test');
    expect(dismissed.resolvedAt).toBeTruthy();
    // Dismissed, not deleted: the next analysis should know it was considered.
    expect(await store.listImpacts(id)).toHaveLength(1);
  });

  it('filters findings by status', async () => {
    const { id, blocks } = await seed();
    const analysisId = await analysisWithOneFinding(id, blocks);
    const [impact] = await store.listImpacts(id, { analysisId });

    await store.setImpactStatus(id, impact.id, {
      status: 'accepted_no_change',
      resolvedBy: 'usr_test',
    });

    expect(await store.listImpacts(id, { statuses: ['pending'] })).toHaveLength(0);
    expect(await store.listImpacts(id, { statuses: ['accepted_no_change'] })).toHaveLength(1);
  });

  it('reports an unknown finding', async () => {
    const { id } = await seed();

    await expect(
      store.setImpactStatus(id, 'imp_missing', { status: 'dismissed', resolvedBy: 'usr_test' }),
    ).rejects.toBeInstanceOf(ImpactNotFoundError);
  });

  it('marks analysed ledger entries so they are not re-analysed', async () => {
    const { id, blocks, content } = await seed();

    const edited = JSON.parse(JSON.stringify(content)) as DocumentContent;
    edited.content[1].content = [{ type: 'text', text: 'The likelihood of an incident.' }];

    const saved = await store.saveDocument(id, {
      content: edited,
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [draft(blocks[1].id, 'The probability of an incident.', 'The likelihood of an incident.')],
    });

    expect(saved.changes[0].impactStatus).toBe('pending');

    await store.markChangesAnalysed(id, [saved.changes[0].id]);
    const ledger = await store.listChanges(id);
    expect(ledger[0].impactStatus).toBe('analyzed');
  });

  it('records a failed analysis without findings', async () => {
    const { id } = await seed();
    const analysis = await store.createImpactAnalysis(id, {
      baseCheckpointId: null,
      targetRevision: 1,
      clusters: [],
      retrieval: { blocksInDocument: 3, candidatesConsidered: 0, reductionPercent: 100 },
      changesAnalysed: 1,
      changesFiltered: 0,
    });

    const failed = await store.completeImpactAnalysis(id, analysis.id, {
      status: 'failed',
      summary: '',
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      error: 'The model did not return a readable analysis.',
      impacts: [],
    });

    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('readable');
    expect(await store.listImpacts(id)).toHaveLength(0);
  });

  it('lists analyses newest first', async () => {
    const { id, blocks } = await seed();
    await analysisWithOneFinding(id, blocks);
    await analysisWithOneFinding(id, blocks);

    const analyses = await store.listImpactAnalyses(id);
    expect(analyses).toHaveLength(2);
    expect(analyses[0].createdAt >= analyses[1].createdAt).toBe(true);
  });
});
