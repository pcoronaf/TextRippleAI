import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import { parseModifyResponse, UnusableProposalError } from '@/ai/prompts';
import {
  FileStore,
  RevisionConflictError,
  SuggestionNotFoundError,
  SuggestionResolvedError,
  SuggestionStaleError,
} from '@/store';
import type { DocumentContent } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-sug-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let store: FileStore;
beforeEach(() => {
  store = new FileStore(path.join(root, `run-${Math.random().toString(36).slice(2)}`));
});

const ORIGINAL = 'Artificial intelligence systems always require human supervision.';
const PROPOSED =
  'High-risk artificial intelligence systems should normally remain subject to meaningful human oversight.';

const manuscript = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: ORIGINAL }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'An untouched paragraph.' }] },
    ],
  }).content;

async function seed() {
  const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
  const blocks = flattenBlocks(created.content);
  return { id: created.document.id, blocks, content: created.content };
}

async function propose(
  documentId: string,
  blockId: string,
  overrides: Partial<Parameters<FileStore['createSuggestion']>[1]> = {},
) {
  return store.createSuggestion(documentId, {
    blockId,
    conversationId: null,
    instruction: 'Make this assertion less absolute.',
    before: ORIGINAL,
    proposed: PROPOSED,
    rationale: 'Softened an unqualified claim.',
    selectionStart: 0,
    selectionEnd: ORIGINAL.length,
    provider: 'mock',
    model: 'mock-reasoning',
    inputTokens: 120,
    outputTokens: 45,
    contextDigest: null,
    parentSuggestionId: null,
    baseRevision: 1,
    ...overrides,
  });
}

describe('parseModifyResponse', () => {
  it('separates the replacement from the rationale', () => {
    const parsed = parseModifyResponse(
      '<replacement>\nThe new text.\n</replacement>\n<rationale>\nBecause.\n</rationale>',
    );
    expect(parsed).toEqual({ proposed: 'The new text.', rationale: 'Because.' });
  });

  it('treats an untagged reply as the replacement', () => {
    // A model that ignores the format still produces something reviewable.
    expect(parseModifyResponse('Just the replacement.').proposed).toBe('Just the replacement.');
  });

  it('refuses an empty proposal rather than proposing a deletion', () => {
    expect(() => parseModifyResponse('<replacement>\n\n</replacement>')).toThrow(
      UnusableProposalError,
    );
    expect(() => parseModifyResponse('   ')).toThrow(UnusableProposalError);
  });
});

describe('suggestions', () => {
  it('records a proposal without touching the document', () => {
    return (async () => {
      const { id, blocks, content } = await seed();
      const suggestion = await propose(id, blocks[1].id);

      expect(suggestion.status).toBe('generated');
      expect(suggestion.proposed).toBe(PROPOSED);

      const after = await store.getDocument(id);
      expect(after?.content).toEqual(content);
      expect(after?.document.currentRevision).toBe(1);
      expect(await store.listChanges(id)).toHaveLength(0);
    })();
  });

  it('applies an accepted proposal and records where the text came from', async () => {
    const { id, blocks } = await seed();
    const suggestion = await propose(id, blocks[1].id);

    const result = await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 1,
    });

    expect(result.document.currentRevision).toBe(2);
    expect(flattenBlocks(result.content)[1].text).toBe(PROPOSED);
    // The paragraph keeps its identity through the rewrite.
    expect(flattenBlocks(result.content)[1].id).toBe(blocks[1].id);

    expect(result.change).toMatchObject({
      blockId: blocks[1].id,
      source: 'ai_accepted',
      operation: 'replace',
      before: ORIGINAL,
      after: PROPOSED,
      prompt: 'Make this assertion less absolute.',
      model: 'mock:mock-reasoning',
      suggestionId: suggestion.id,
      authorId: 'usr_test',
      impactStatus: 'pending',
    });
    expect(result.change.afterHash).toBe(contentHash(PROPOSED));

    expect(result.suggestion.status).toBe('accepted');
    expect(result.suggestion.changeId).toBe(result.change.id);
    expect(result.suggestion.resolvedBy).toBe('usr_test');
  });

  it('writes exactly one ledger entry for an accepted proposal', async () => {
    const { id, blocks } = await seed();
    const suggestion = await propose(id, blocks[1].id);
    await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 1,
    });

    const ledger = await store.listChanges(id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].source).toBe('ai_accepted');
  });

  it('leaves the document untouched when a proposal is rejected', async () => {
    const { id, blocks, content } = await seed();
    const suggestion = await propose(id, blocks[1].id);

    const rejected = await store.setSuggestionStatus(id, suggestion.id, {
      status: 'rejected',
      resolvedBy: 'usr_test',
    });

    expect(rejected.status).toBe('rejected');
    const after = await store.getDocument(id);
    expect(after?.content).toEqual(content);
    expect(after?.document.currentRevision).toBe(1);
    expect(await store.listChanges(id)).toHaveLength(0);
  });

  it('refuses to apply a proposal twice', async () => {
    const { id, blocks } = await seed();
    const suggestion = await propose(id, blocks[1].id);

    await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 1,
    });

    await expect(
      store.acceptSuggestion(id, suggestion.id, { acceptedBy: 'usr_test', expectedRevision: 2 }),
    ).rejects.toBeInstanceOf(SuggestionResolvedError);
  });

  it('refuses to apply a rejected proposal', async () => {
    const { id, blocks } = await seed();
    const suggestion = await propose(id, blocks[1].id);
    await store.setSuggestionStatus(id, suggestion.id, { status: 'rejected' });

    await expect(
      store.acceptSuggestion(id, suggestion.id, { acceptedBy: 'usr_test', expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(SuggestionResolvedError);
  });

  it('refuses to apply a proposal whose passage has since changed', async () => {
    const { id, blocks, content } = await seed();
    const suggestion = await propose(id, blocks[1].id);

    // The author edits the same paragraph by hand before reviewing.
    const edited = JSON.parse(JSON.stringify(content)) as DocumentContent;
    edited.content[1].content = [{ type: 'text', text: 'The author rewrote this themselves.' }];
    await store.saveDocument(id, {
      content: edited,
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });

    // Applying the proposal now would silently discard that work.
    await expect(
      store.acceptSuggestion(id, suggestion.id, { acceptedBy: 'usr_test', expectedRevision: 2 }),
    ).rejects.toBeInstanceOf(SuggestionStaleError);

    const after = await store.getDocument(id);
    expect(flattenBlocks(after!.content)[1].text).toBe('The author rewrote this themselves.');
  });

  it('rejects acceptance against a stale revision', async () => {
    const { id, blocks } = await seed();
    const suggestion = await propose(id, blocks[1].id);

    await expect(
      store.acceptSuggestion(id, suggestion.id, { acceptedBy: 'usr_test', expectedRevision: 99 }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('reports an unknown proposal', async () => {
    const { id } = await seed();

    await expect(
      store.acceptSuggestion(id, 'sug_missing', { acceptedBy: 'usr_test', expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(SuggestionNotFoundError);
  });

  it('supersedes an earlier proposal when a revision is made', async () => {
    const { id, blocks } = await seed();
    const first = await propose(id, blocks[1].id);

    const second = await propose(id, blocks[1].id, {
      instruction: 'Softer still.',
      proposed: 'Human oversight should normally apply to high-risk systems.',
      parentSuggestionId: first.id,
    });
    await store.setSuggestionStatus(id, first.id, { status: 'revised' });

    const all = await store.listSuggestions(id, { blockId: blocks[1].id });
    const byId = new Map(all.map((entry) => [entry.id, entry]));

    expect(byId.get(first.id)?.status).toBe('revised');
    expect(byId.get(second.id)?.status).toBe('generated');
    expect(byId.get(second.id)?.parentSuggestionId).toBe(first.id);
  });

  it('filters proposals by block and status', async () => {
    const { id, blocks } = await seed();
    await propose(id, blocks[1].id);
    const other = await propose(id, blocks[2].id, { before: 'An untouched paragraph.' });
    await store.setSuggestionStatus(id, other.id, { status: 'rejected' });

    expect(await store.listSuggestions(id)).toHaveLength(2);
    expect(await store.listSuggestions(id, { blockId: blocks[1].id })).toHaveLength(1);
    expect(await store.listSuggestions(id, { statuses: ['generated'] })).toHaveLength(1);
    expect(await store.listSuggestions(id, { statuses: ['rejected'] })).toHaveLength(1);
  });

  it('can be traced from the ledger entry back to the prompt that produced it', async () => {
    const { id, blocks } = await seed();
    const suggestion = await propose(id, blocks[1].id);
    const { change } = await store.acceptSuggestion(id, suggestion.id, {
      acceptedBy: 'usr_test',
      expectedRevision: 1,
    });

    const traced = await store.getSuggestion(id, change.suggestionId!);
    expect(traced?.instruction).toBe(change.prompt);
    expect(traced?.changeId).toBe(change.id);
    expect(`${traced?.provider}:${traced?.model}`).toBe(change.model);
  });
});
