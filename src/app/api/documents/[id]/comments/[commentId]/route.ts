import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; commentId: string }> };

/** Resolve or reopen a remark. Comments are never deleted. */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id, commentId } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.status !== 'open' && body.status !== 'resolved') {
      return NextResponse.json({ error: 'status must be open or resolved' }, { status: 400 });
    }

    const comment = await getStore().setCommentStatus(id, commentId, {
      status: body.status,
      resolvedBy: CURRENT_USER_ID,
    });

    return NextResponse.json({ comment });
  } catch (error) {
    return handleError(error);
  }
}
