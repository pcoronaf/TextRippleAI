import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAskContext } from '@/ai/context-builder';
import {
  decisionApplies,
  decisionSuppresses,
  decisionsFor,
  detectDecisionConflicts,
  extractPreferences,
  searchDecisions,
} from '@/core/decisions';
import { enclosingHeadings, ensureNodeIds, flattenBlocks } from '@/core/document';
import { FileStore } from '@/store';
import type { DecisionRecord, DocumentContent, DocumentRecord } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-dec-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let store: FileStore;
beforeEach(() => {
  store = new FileStore(path.join(root, `run-${Math.random().toString(36).slice(2)}`));
});

const content: DocumentContent = ensureNodeIds({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Early paragraph.' }] },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter Three' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Oversight' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Middle paragraph.' }] },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter Eight' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Late paragraph.' }] },
  ],
}).content;

const blocks = flattenBlocks(content);
const enclosing = enclosingHeadings(content);
const byText = (text: string) => blocks.find((block) => block.text === text)!;

const decision = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'dec_1',
  documentId: 'doc_1',
  title: 'A decision',
  description: '',
  scope: { type: 'document' },
  status: 'accepted',
  source: 'manual',
  suppressBlockId: null,
  suppressTerms: [],
  suppressImpactType: null,
  sourceImpactId: null,
  sourceConversationId: null,
  supersedesDecisionId: null,
  createdBy: 'usr_test',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('decision scope', () => {
  it('a document-scoped decision applies everywhere', () => {
    for (const block of blocks) {
      expect(decisionApplies({ type: 'document' }, block.id, blocks, enclosing)).toBe(true);
    }
  });

  it('a node-scoped decision applies to that node and its section', () => {
    const section = byText('Oversight');
    const inside = byText('Middle paragraph.');
    const elsewhere = byText('Late paragraph.');

    const scope = { type: 'node', nodeId: section.id } as const;
    expect(decisionApplies(scope, section.id, blocks, enclosing)).toBe(true);
    expect(decisionApplies(scope, inside.id, blocks, enclosing)).toBe(true);
    expect(decisionApplies(scope, elsewhere.id, blocks, enclosing)).toBe(false);
  });

  it('a from_node decision governs what follows but not what precedes', () => {
    // The spec's example: a choice taken in Chapter 3 that governs the rest.
    const anchor = byText('Chapter Three');
    const scope = { type: 'from_node', nodeId: anchor.id } as const;

    expect(decisionApplies(scope, byText('Early paragraph.').id, blocks, enclosing)).toBe(false);
    expect(decisionApplies(scope, byText('Middle paragraph.').id, blocks, enclosing)).toBe(true);
    expect(decisionApplies(scope, byText('Late paragraph.').id, blocks, enclosing)).toBe(true);
  });

  it('only accepted decisions are in force', () => {
    const all = [
      decision({ id: 'dec_a', status: 'accepted' }),
      decision({ id: 'dec_b', status: 'retired' }),
      decision({ id: 'dec_c', status: 'superseded' }),
    ];

    const inForce = decisionsFor(all, byText('Late paragraph.').id, blocks, enclosing);
    expect(inForce.map((entry) => entry.id)).toEqual(['dec_a']);
  });
});

describe('suppression', () => {
  const target = 'p_target';

  it('silences a finding about the passage and vocabulary it names', () => {
    const settled = decision({
      suppressBlockId: target,
      suppressTerms: ['probability'],
    });

    expect(
      decisionSuppresses(settled, {
        targetBlockId: target,
        impactType: 'terminology_consistency',
        terms: ['probability', 'likelihood'],
      }),
    ).toBe(true);
  });

  it('does not silence a different passage', () => {
    const settled = decision({ suppressBlockId: target, suppressTerms: ['probability'] });

    expect(
      decisionSuppresses(settled, {
        targetBlockId: 'p_other',
        impactType: 'terminology_consistency',
        terms: ['probability'],
      }),
    ).toBe(false);
  });

  it('does not silence different vocabulary in the same passage', () => {
    // A decision about one term must not blanket-silence the passage.
    const settled = decision({ suppressBlockId: target, suppressTerms: ['probability'] });

    expect(
      decisionSuppresses(settled, {
        targetBlockId: target,
        impactType: 'definition_conflict',
        terms: ['threshold'],
      }),
    ).toBe(false);
  });

  it('narrows by impact type when one is named', () => {
    const settled = decision({
      suppressBlockId: target,
      suppressTerms: [],
      suppressImpactType: 'terminology_consistency',
    });

    expect(
      decisionSuppresses(settled, { targetBlockId: target, impactType: 'terminology_consistency', terms: [] }),
    ).toBe(true);
    expect(
      decisionSuppresses(settled, { targetBlockId: target, impactType: 'contradiction', terms: [] }),
    ).toBe(false);
  });

  it('a decision that names no passage suppresses nothing', () => {
    // A general preference informs the model; it does not silence findings.
    const general = decision({ description: 'Prefer plain language throughout.' });

    expect(
      decisionSuppresses(general, { targetBlockId: target, impactType: 'other', terms: ['x'] }),
    ).toBe(false);
  });

  it('a retired decision stops suppressing', () => {
    const settled = decision({ suppressBlockId: target, status: 'retired' });

    expect(
      decisionSuppresses(settled, { targetBlockId: target, impactType: 'other', terms: [] }),
    ).toBe(false);
  });
});

describe('conflict detection', () => {
  it('reads a directional preference', () => {
    expect(
      extractPreferences("Use 'human oversight' rather than 'human supervision' throughout."),
    ).toEqual([{ preferred: 'human oversight', rejected: 'human supervision' }]);

    expect(extractPreferences('Prefer likelihood over probability.')).toEqual([
      { preferred: 'likelihood', rejected: 'probability' },
    ]);
  });

  it('finds two decisions that contradict each other outright', () => {
    const conflicts = detectDecisionConflicts([
      decision({ id: 'dec_a', description: 'Use likelihood rather than probability.' }),
      decision({ id: 'dec_b', description: 'Use probability rather than likelihood.' }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('inverted');
    expect(conflicts[0].explanation).toContain('likelihood');
  });

  it('finds two decisions replacing the same term differently', () => {
    const conflicts = detectDecisionConflicts([
      decision({ id: 'dec_a', description: 'Use likelihood rather than probability.' }),
      decision({ id: 'dec_b', description: 'Use chance rather than probability.' }),
    ]);

    expect(conflicts[0]?.kind).toBe('competing');
  });

  it('leaves compatible decisions alone', () => {
    expect(
      detectDecisionConflicts([
        decision({ id: 'dec_a', description: 'Use likelihood rather than probability.' }),
        decision({ id: 'dec_b', description: 'Use oversight rather than supervision.' }),
      ]),
    ).toEqual([]);
  });

  it('ignores decisions that are no longer in force', () => {
    expect(
      detectDecisionConflicts([
        decision({ id: 'dec_a', description: 'Use likelihood rather than probability.' }),
        decision({
          id: 'dec_b',
          status: 'superseded',
          description: 'Use probability rather than likelihood.',
        }),
      ]),
    ).toEqual([]);
  });
});

describe('search', () => {
  it('matches on title and description', () => {
    const all = [
      decision({ id: 'dec_a', title: 'Oversight terminology', description: 'Prefer oversight.' }),
      decision({ id: 'dec_b', title: 'Citation style', description: 'Use numbered citations.' }),
    ];

    expect(searchDecisions(all, 'oversight').map((entry) => entry.id)).toEqual(['dec_a']);
    expect(searchDecisions(all, 'numbered').map((entry) => entry.id)).toEqual(['dec_b']);
    expect(searchDecisions(all, '')).toHaveLength(2);
  });
});

describe('decision persistence', () => {
  async function seed() {
    const created = await store.createDocument({ content, authorId: 'usr_test' });
    return created.document.id;
  }

  it('records a decision and returns it in force', async () => {
    const id = await seed();

    const created = await store.createDecision(id, {
      title: 'Prefer human oversight terminology',
      description: "Use 'human oversight' rather than 'human supervision'.",
      scope: { type: 'document' },
      source: 'manual',
      createdBy: 'usr_test',
    });

    expect(created.status).toBe('accepted');
    expect(await store.listDecisions(id, { statuses: ['accepted'] })).toHaveLength(1);
  });

  it('supersedes the decision it replaces, in the same write', async () => {
    const id = await seed();
    const first = await store.createDecision(id, {
      title: 'Old wording',
      description: 'Use supervision rather than oversight.',
      scope: { type: 'document' },
      source: 'manual',
      createdBy: 'usr_test',
    });

    await store.createDecision(id, {
      title: 'New wording',
      description: 'Use oversight rather than supervision.',
      scope: { type: 'document' },
      source: 'manual',
      createdBy: 'usr_test',
      supersedesDecisionId: first.id,
    });

    const all = await store.listDecisions(id);
    expect(all.find((entry) => entry.id === first.id)?.status).toBe('superseded');
    // Never both in force at once, so they cannot be read as contradicting.
    expect(detectDecisionConflicts(all)).toEqual([]);
  });

  it('retires without deleting', async () => {
    const id = await seed();
    const created = await store.createDecision(id, {
      title: 'A decision',
      description: 'Reasoning worth keeping.',
      scope: { type: 'document' },
      source: 'manual',
      createdBy: 'usr_test',
    });

    const retired = await store.updateDecision(id, created.id, { status: 'retired' });

    expect(retired.status).toBe('retired');
    // The reasoning stays readable even once the choice has moved on.
    expect(await store.listDecisions(id)).toHaveLength(1);
    expect(await store.listDecisions(id, { statuses: ['accepted'] })).toHaveLength(0);
  });

  it('keeps where it came from', async () => {
    const id = await seed();
    const created = await store.createDecision(id, {
      title: 'Do not propagate to this passage',
      description: 'Chapter 8 discusses continuous monitoring, a separate concept.',
      scope: { type: 'node', nodeId: byText('Late paragraph.').id },
      source: 'impact_review',
      createdBy: 'usr_test',
      suppressBlockId: byText('Late paragraph.').id,
      suppressTerms: ['supervision'],
      sourceImpactId: 'imp_42',
    });

    expect(created.source).toBe('impact_review');
    expect(created.sourceImpactId).toBe('imp_42');
    expect(created.suppressTerms).toEqual(['supervision']);
  });
});

describe('decisions reach the Context Builder', () => {
  const document: DocumentRecord = {
    id: 'doc_1',
    workspaceId: 'ws_local',
    title: 'Governance',
    currentRevision: 2,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const base = {
    document,
    content,
    blockId: byText('Middle paragraph.').id,
    question: 'Is this consistent?',
  };

  it('sends applicable decisions with the request', () => {
    const built = buildAskContext({
      ...base,
      decisions: [
        {
          title: 'Prefer human oversight terminology',
          description: "Use 'human oversight' rather than 'human supervision'.",
        },
      ],
    });

    const part = built.parts.find((entry) => entry.label === 'Decisions already taken');
    expect(part?.text).toContain('human oversight');
    // The last gap the digest declared is now closed.
    expect(built.digest.omitted.join(' ')).not.toContain('Applicable decisions');
  });

  it('says so when no decision covers the passage', () => {
    const built = buildAskContext(base);

    expect(built.parts.map((entry) => entry.label)).not.toContain('Decisions already taken');
    expect(built.digest.omitted.join(' ')).toContain('Applicable decisions');
  });
});
