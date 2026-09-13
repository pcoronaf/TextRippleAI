import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { CommentNotFoundError, FileStore } from '@/store';
import type { DocumentContent } from '@/core/types';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-comments-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let store: FileStore;
beforeEach(() => {
  store = new FileStore(path.join(root, `run-${Math.random().toString(36).slice(2)}`));
});

const manuscript = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'The first paragraph.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'The second paragraph.' }] },
    ],
  }).content;

async function seed() {
  const created = await store.createDocument({ content: manuscript(), authorId: 'usr_test' });
  return { id: created.document.id, blocks: flattenBlocks(created.content) };
}

describe('comments', () => {
  it('anchors a remark to a block', async () => {
    const { id, blocks } = await seed();

    const comment = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'Is "required" too strong here?',
      authorId: 'usr_test',
    });

    expect(comment.status).toBe('open');
    expect(comment.blockId).toBe(blocks[0].id);
    expect(await store.listComments(id, { blockId: blocks[0].id })).toHaveLength(1);
    expect(await store.listComments(id, { blockId: blocks[1].id })).toHaveLength(0);
  });

  it('never touches the document', async () => {
    const { id, blocks } = await seed();
    const before = await store.getDocument(id);

    await store.createComment(id, { blockId: blocks[0].id, body: 'A note.', authorId: 'usr_test' });

    const after = await store.getDocument(id);
    expect(after?.content).toEqual(before?.content);
    expect(after?.document.currentRevision).toBe(1);
    expect(await store.listChanges(id)).toHaveLength(0);
  });

  it('resolves and reopens without deleting', async () => {
    const { id, blocks } = await seed();
    const comment = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'A note.',
      authorId: 'usr_test',
    });

    const resolved = await store.setCommentStatus(id, comment.id, {
      status: 'resolved',
      resolvedBy: 'usr_reviewer',
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe('usr_reviewer');
    expect(resolved.resolvedAt).toBeTruthy();

    const reopened = await store.setCommentStatus(id, comment.id, {
      status: 'open',
      resolvedBy: 'usr_reviewer',
    });
    expect(reopened.status).toBe('open');
    // Reopening clears the resolution rather than leaving a stale one behind.
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedBy).toBeNull();

    expect(await store.listComments(id)).toHaveLength(1);
  });

  it('filters by status', async () => {
    const { id, blocks } = await seed();
    const first = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'One.',
      authorId: 'usr_test',
    });
    await store.createComment(id, { blockId: blocks[1].id, body: 'Two.', authorId: 'usr_test' });
    await store.setCommentStatus(id, first.id, { status: 'resolved', resolvedBy: 'usr_test' });

    expect(await store.listComments(id, { statuses: ['open'] })).toHaveLength(1);
    expect(await store.listComments(id, { statuses: ['resolved'] })).toHaveLength(1);
  });

  it('reports an unknown comment', async () => {
    const { id } = await seed();

    await expect(
      store.setCommentStatus(id, 'cmt_missing', { status: 'resolved', resolvedBy: 'usr_test' }),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
  });

  it('keeps a comment whose block has been deleted', async () => {
    const { id, blocks } = await seed();
    await store.createComment(id, { blockId: blocks[0].id, body: 'A note.', authorId: 'usr_test' });

    // Delete the commented block. Nothing here removes the comment - the route
    // that lists them reports the anchor as orphaned instead.
    const loaded = await store.getDocument(id);
    await store.saveDocument(id, {
      content: { ...loaded!.content, content: loaded!.content.content.slice(1) },
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });

    const remaining = await store.listComments(id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].blockId).toBe(blocks[0].id);

    const after = await store.getDocument(id);
    const present = flattenBlocks(after!.content).map((block) => block.id);
    expect(present).not.toContain(blocks[0].id);
  });

  it('survives a document save', async () => {
    const { id, blocks } = await seed();
    await store.createComment(id, { blockId: blocks[0].id, body: 'A note.', authorId: 'usr_test' });

    const loaded = await store.getDocument(id);
    await store.saveDocument(id, {
      content: loaded!.content,
      expectedRevision: 1,
      authorId: 'usr_test',
      changes: [],
    });

    expect(await store.listComments(id)).toHaveLength(1);
  });
});

describe('comment threads', () => {
  it('replies inherit the anchor of the comment they answer', async () => {
    const { id, blocks } = await seed();
    const root = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'Is "required" too strong?',
      authorId: 'usr_test',
    });

    // Deliberately passing a different block: the reply must follow its parent,
    // so a thread cannot end up split across two passages.
    const reply = await store.createComment(id, {
      blockId: blocks[1].id,
      parentId: root.id,
      body: 'Agreed, "expected" reads better.',
      authorId: 'usr_other',
    });

    expect(reply.parentId).toBe(root.id);
    expect(reply.blockId).toBe(blocks[0].id);
  });

  it('keeps threads one level deep', async () => {
    const { id, blocks } = await seed();
    const root = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'One.',
      authorId: 'usr_test',
    });
    const first = await store.createComment(id, {
      blockId: blocks[0].id,
      parentId: root.id,
      body: 'Two.',
      authorId: 'usr_test',
    });
    const second = await store.createComment(id, {
      blockId: blocks[0].id,
      parentId: first.id,
      body: 'Three.',
      authorId: 'usr_test',
    });

    // Replying to a reply joins the same thread rather than nesting further.
    expect(second.parentId).toBe(root.id);
  });

  it('reports an unknown parent', async () => {
    const { id, blocks } = await seed();

    await expect(
      store.createComment(id, {
        blockId: blocks[0].id,
        parentId: 'cmt_missing',
        body: 'Reply to nothing.',
        authorId: 'usr_test',
      }),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
  });

  it('opens a thread with no parent', async () => {
    const { id, blocks } = await seed();
    const root = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'A remark.',
      authorId: 'usr_test',
    });

    expect(root.parentId).toBeNull();
  });

  it('resolving the thread does not touch its replies', async () => {
    const { id, blocks } = await seed();
    const root = await store.createComment(id, {
      blockId: blocks[0].id,
      body: 'Open question.',
      authorId: 'usr_test',
    });
    await store.createComment(id, {
      blockId: blocks[0].id,
      parentId: root.id,
      body: 'An answer.',
      authorId: 'usr_test',
    });

    await store.setCommentStatus(id, root.id, { status: 'resolved', resolvedBy: 'usr_test' });

    const all = await store.listComments(id);
    const stored = all.find((entry) => entry.id === root.id);
    const reply = all.find((entry) => entry.parentId === root.id);

    // Resolution is a property of the thread, read from its root.
    expect(stored?.status).toBe('resolved');
    expect(reply?.status).toBe('open');
  });
});
