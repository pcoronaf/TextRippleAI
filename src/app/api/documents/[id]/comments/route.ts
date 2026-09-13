import { NextResponse } from 'next/server';

import { flattenBlocks } from '@/core/document';
import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';
import type { CommentStatus } from '@/core/types';

type Context = { params: Promise<{ id: string }> };

const STATUSES: CommentStatus[] = ['open', 'resolved'];

export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;

    const statuses = query.getAll('status').filter((value): value is CommentStatus =>
      STATUSES.includes(value as CommentStatus),
    );

    const store = getStore();
    const comments = await store.listComments(id, {
      blockId: query.get('blockId') ?? undefined,
      statuses: statuses.length > 0 ? statuses : undefined,
    });

    // A comment is never deleted, so one whose block has been removed since
    // outlives its anchor. It is still worth reading - it may be the reason the
    // passage went - but showing it as though it still points at something is a
    // lie, so the state is reported rather than hidden.
    const loaded = await store.getDocument(id);
    const present = new Set(loaded ? flattenBlocks(loaded.content).map((block) => block.id) : []);

    return NextResponse.json({
      comments: comments.map((comment) => ({
        ...comment,
        orphaned: !present.has(comment.blockId),
      })),
    });
  } catch (error) {
    return handleError(error);
  }
}

/** A review remark anchored to a block. Inert: nothing acts on it. */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const blockId = typeof body.blockId === 'string' ? body.blockId : '';
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : undefined;
    const text = String(body.body ?? '').trim();

    // A reply takes its anchor from the comment it answers, so only a new
    // thread has to name a block.
    if (!blockId && !parentId) {
      return NextResponse.json({ error: 'blockId or parentId is required' }, { status: 400 });
    }
    if (!text) return NextResponse.json({ error: 'A comment body is required' }, { status: 400 });

    const comment = await getStore().createComment(id, {
      blockId,
      parentId,
      body: text,
      authorId: CURRENT_USER_ID,
    });

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
