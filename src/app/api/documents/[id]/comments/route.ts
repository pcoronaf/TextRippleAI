import { NextResponse } from 'next/server';

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

    return NextResponse.json({
      comments: await getStore().listComments(id, {
        blockId: query.get('blockId') ?? undefined,
        statuses: statuses.length > 0 ? statuses : undefined,
      }),
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
    const text = String(body.body ?? '').trim();

    if (!blockId) return NextResponse.json({ error: 'blockId is required' }, { status: 400 });
    if (!text) return NextResponse.json({ error: 'A comment body is required' }, { status: 400 });

    const comment = await getStore().createComment(id, {
      blockId,
      body: text,
      authorId: CURRENT_USER_ID,
    });

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
