import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const document = await getStore().getDocument(id);
    if (!document) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    return NextResponse.json(document);
  } catch (error) {
    return handleError(error);
  }
}

/** Save the document and append the accompanying changes in one transaction. */
export async function PUT(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (!body?.content || typeof body.expectedRevision !== 'number') {
      return NextResponse.json(
        { error: 'content and expectedRevision are required' },
        { status: 400 },
      );
    }

    const result = await getStore().saveDocument(id, {
      content: body.content,
      expectedRevision: body.expectedRevision,
      authorId: CURRENT_USER_ID,
      changes: Array.isArray(body.changes) ? body.changes : [],
      title: body.title,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await getStore().deleteDocument(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleError(error);
  }
}
