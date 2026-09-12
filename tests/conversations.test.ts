import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash } from '@/core/hash';
import { ConversationNotFoundError, FileStore } from '@/store';
import type { ContextDigest, DocumentContent } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-conv-'));
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

const digest: ContextDigest = {
  parts: [{ label: 'Selected text', text: 'The opening paragraph.', tokens: 6 }],
  totalTokens: 6,
  documentTokens: 20,
  documentPercent: 30,
  budgetTokens: 3000,
  omitted: [],
};

async function seed() {
  const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
  const blocks = flattenBlocks(created.content);
  return { id: created.document.id, blocks, content: created.content };
}

describe('conversation persistence', () => {
  it('anchors a conversation to a block', async () => {
    const { id, blocks } = await seed();

    const conversation = await store.createConversation(id, {
      anchorBlockId: blocks[1].id,
      selection: { from: 4, to: 20 },
      selectionText: 'opening paragraph',
      title: 'Is this too absolute?',
    });

    expect(conversation.documentId).toBe(id);
    expect(conversation.anchorBlockId).toBe(blocks[1].id);
    expect(conversation.selection).toEqual({ from: 4, to: 20 });
    expect(await store.getConversation(id, conversation.id)).toEqual(conversation);
  });

  it('keeps turns in order and records provenance on the answer', async () => {
    const { id, blocks } = await seed();
    const conversation = await store.createConversation(id, {
      anchorBlockId: blocks[1].id,
      selection: null,
      selectionText: 'The opening paragraph.',
      title: 'Question',
    });

    await store.appendMessage(id, conversation.id, {
      role: 'user',
      content: 'Is this too absolute?',
      contextDigest: digest,
    });
    await store.appendMessage(id, conversation.id, {
      role: 'assistant',
      content: 'Somewhat - "always" leaves no room for exceptions.',
      provider: 'mock',
      model: 'mock-reasoning',
      inputTokens: 120,
      outputTokens: 40,
    });

    const messages = await store.listMessages(id, conversation.id);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0].contextDigest).toEqual(digest);
    expect(messages[1]).toMatchObject({
      provider: 'mock',
      model: 'mock-reasoning',
      inputTokens: 120,
      outputTokens: 40,
    });
    // Token counts sit on the answer only, so totals are not double-counted.
    expect(messages[0].inputTokens).toBe(0);
  });

  it('finds the conversation anchored to a given block', async () => {
    const { id, blocks } = await seed();

    const first = await store.createConversation(id, {
      anchorBlockId: blocks[1].id,
      selection: null,
      selectionText: 'one',
      title: 'First',
    });
    await store.createConversation(id, {
      anchorBlockId: blocks[2].id,
      selection: null,
      selectionText: 'two',
      title: 'Second',
    });

    const anchored = await store.listConversations(id, { anchorBlockId: blocks[1].id });
    expect(anchored.map((conversation) => conversation.id)).toEqual([first.id]);
    expect(await store.listConversations(id)).toHaveLength(2);
  });

  it('rejects a message for an unknown conversation', async () => {
    const { id } = await seed();

    await expect(
      store.appendMessage(id, 'conv_missing', { role: 'user', content: 'Hello' }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('survives a document save', async () => {
    const { id, blocks, content } = await seed();

    const conversation = await store.createConversation(id, {
      anchorBlockId: blocks[1].id,
      selection: null,
      selectionText: 'The opening paragraph.',
      title: 'Question',
    });
    await store.appendMessage(id, conversation.id, { role: 'user', content: 'Is this clear?' });

    const edited = JSON.parse(JSON.stringify(content)) as DocumentContent;
    edited.content[1].content = [{ type: 'text', text: 'Rewritten opening.' }];

    await store.saveDocument(id, {
      content: edited,
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [
        {
          blockId: blocks[1].id,
          blockType: 'paragraph',
          operation: 'replace',
          before: 'The opening paragraph.',
          after: 'Rewritten opening.',
          beforeHash: contentHash('The opening paragraph.'),
          afterHash: contentHash('Rewritten opening.'),
          classification: 'editorial',
          sessionId: 'sess_test',
          occurredAt: new Date().toISOString(),
        },
      ],
    });

    expect(await store.listConversations(id)).toHaveLength(1);
    expect(await store.listMessages(id, conversation.id)).toHaveLength(1);
  });
});
