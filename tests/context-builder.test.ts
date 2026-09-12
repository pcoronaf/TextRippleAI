import { describe, expect, it } from 'vitest';

import { BlockNotFoundError, buildAskContext, estimateTokens } from '@/ai/context-builder';
import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import type { ChangeRecord, DocumentContent, DocumentRecord, MessageRecord } from '@/core/types';

const document: DocumentRecord = {
  id: 'doc_test',
  workspaceId: 'ws_local',
  title: 'Governance of High-Risk Systems',
  currentRevision: 4,
  status: 'draft',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const heading = (text: string, level: number) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const content: DocumentContent = ensureNodeIds({
  type: 'doc',
  content: [
    heading('Chapter Three', 1),
    paragraph('Far above the selection, and not relevant to it.'),
    heading('Human oversight', 2),
    paragraph('The paragraph immediately before the selection.'),
    paragraph('Zero Trust assumes that no user, device or application should automatically be trusted.'),
    paragraph('The paragraph immediately after the selection.'),
    paragraph('Far below the selection, and not relevant to it.'),
  ],
}).content;

const blocks = flattenBlocks(content);
const selected = blocks[4];
const labels = (parts: { label: string }[]) => parts.map((part) => part.label);

const message = (role: 'user' | 'assistant', text: string): MessageRecord => ({
  id: `msg_${role}`,
  conversationId: 'conv_1',
  role,
  content: text,
  provider: null,
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  contextDigest: null,
  createdAt: new Date().toISOString(),
});

const change = (blockId: string, before: string, after: string): ChangeRecord => ({
  id: 'chg_1',
  documentId: document.id,
  blockId,
  blockType: 'paragraph',
  authorId: 'usr_local',
  source: 'human',
  operation: 'replace',
  classification: 'terminology',
  before,
  after,
  beforeHash: contentHash(before),
  afterHash: contentHash(after),
  sessionId: 'sess_1',
  revision: 3,
  checkpointId: null,
  impactStatus: 'pending',
  prompt: null,
  model: null,
  suggestionId: null,
  occurredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

describe('estimateTokens', () => {
  it('scales with length and ignores surrounding whitespace', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('    ')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('buildAskContext', () => {
  const base = { document, content, blockId: selected.id, question: 'Is this too absolute?' };

  it('sends the selection with its immediate neighbours and its location', () => {
    const built = buildAskContext(base);

    expect(labels(built.parts)).toEqual([
      'Where this sits',
      'Previous paragraph',
      'Selected text',
      'Next paragraph',
    ]);

    const text = built.parts.map((part) => part.text).join('\n');
    expect(text).toContain('Zero Trust assumes');
    expect(text).toContain('immediately before');
    expect(text).toContain('immediately after');
  });

  it('does not send the rest of the document', () => {
    const text = buildAskContext(base)
      .parts.map((part) => part.text)
      .join('\n');

    expect(text).not.toContain('Far above the selection');
    expect(text).not.toContain('Far below the selection');
  });

  it('reports where the selection sits in the structure', () => {
    const located = buildAskContext(base).parts.find((part) => part.label === 'Where this sits');

    expect(located?.text).toContain('Document: Governance of High-Risk Systems');
    expect(located?.text).toContain('Chapter: Chapter Three');
    expect(located?.text).toContain('Section: Human oversight');
  });

  it('keeps a paragraph-level request far under the token budget', () => {
    const { digest } = buildAskContext(base);

    expect(digest.totalTokens).toBeLessThan(3000);
    expect(digest.budgetTokens).toBe(3000);
  });

  it('reports what share of the document was sent', () => {
    const { digest } = buildAskContext(base);

    expect(digest.documentTokens).toBeGreaterThan(digest.totalTokens);
    expect(digest.documentPercent).toBeGreaterThan(0);
    expect(digest.documentPercent).toBeLessThan(100);
  });

  it('drops optional context when the budget is tight, but never the selection', () => {
    const { parts, digest } = buildAskContext({ ...base, budgetTokens: 10 });

    expect(labels(parts)).toEqual(['Selected text']);
    expect(digest.omitted.join(' ')).toContain('Previous paragraph');
    expect(digest.omitted.join(' ')).toContain('10-token budget');
  });

  it('says when the index holds no current summaries rather than faking them', () => {
    const omitted = buildAskContext(base).digest.omitted.join(' ');

    expect(omitted).toContain('summaries');
    expect(omitted).toContain('decisions');
  });

  it('sends the hierarchical briefs when the index has them', () => {
    const built = buildAskContext({
      ...base,
      briefs: {
        document: 'The document sets out governance duties for high-risk systems.',
        chapter: 'Chapter three distinguishes oversight from continuous supervision.',
        section: 'This section defines human oversight.',
      },
    });

    expect(labels(built.parts)).toContain('Document brief');
    expect(labels(built.parts)).toContain('Section brief');
    expect(labels(built.parts)).toContain('Chapter brief');
    // The gap M2 declared is closed, so it should stop being reported as one.
    expect(built.digest.omitted.join(' ')).not.toContain('summaries');
  });

  it('puts the briefs before the passage they describe', () => {
    const built = buildAskContext({
      ...base,
      briefs: { document: 'A document brief.', section: 'A section brief.' },
    });
    const order = labels(built.parts);

    expect(order.indexOf('Document brief')).toBeLessThan(order.indexOf('Selected text'));
    expect(order.indexOf('Section brief')).toBeLessThan(order.indexOf('Selected text'));
  });

  it('does not repeat a chapter brief that is also the section brief', () => {
    const shared = 'One and the same brief.';
    const built = buildAskContext({ ...base, briefs: { chapter: shared, section: shared } });

    expect(labels(built.parts).filter((label) => label.endsWith('brief'))).toEqual([
      'Section brief',
    ]);
  });

  it('drops briefs before the selection when the budget is tight', () => {
    const built = buildAskContext({
      ...base,
      briefs: { document: 'word '.repeat(500) },
      budgetTokens: 40,
    });

    expect(labels(built.parts)).toEqual(['Selected text']);
    expect(built.digest.omitted.join(' ')).toContain('Document brief');
  });

  it('honours an explicit selection narrower than the block', () => {
    const built = buildAskContext({ ...base, selectionText: 'no user, device or application' });

    expect(built.selectedText).toBe('no user, device or application');
    expect(built.parts.find((part) => part.label === 'Selected text')?.text).toBe(
      'no user, device or application',
    );
  });

  it('includes recent ledger entries for the selected block only', () => {
    const withOwn = buildAskContext({
      ...base,
      recentChanges: [change(selected.id, 'probability', 'likelihood')],
    });
    expect(labels(withOwn.parts)).toContain('Recent changes to this passage');

    const withOther = buildAskContext({
      ...base,
      recentChanges: [change(blocks[1].id, 'probability', 'likelihood')],
    });
    expect(labels(withOther.parts)).not.toContain('Recent changes to this passage');
  });

  it('does not resend the surroundings on a follow-up turn', () => {
    const built = buildAskContext({
      ...base,
      history: [message('user', 'Is this too absolute?'), message('assistant', 'Somewhat.')],
    });

    // The neighbours are already in the replayed turns; paying for them twice
    // would be the whole token-economy failure this design avoids.
    expect(labels(built.parts)).toEqual(['Selected text']);
    expect(built.digest.omitted.join(' ')).toContain('already present earlier in this conversation');
    expect(built.history).toHaveLength(2);
  });

  it('counts replayed turns against the budget', () => {
    const long = 'word '.repeat(200);
    const { digest } = buildAskContext({
      ...base,
      history: [message('user', long), message('assistant', long)],
    });

    expect(digest.totalTokens).toBeGreaterThan(estimateTokens(long));
  });

  it('rejects a block that is not part of the document', () => {
    expect(() => buildAskContext({ ...base, blockId: 'p_nonexistent' })).toThrow(
      BlockNotFoundError,
    );
  });
});
