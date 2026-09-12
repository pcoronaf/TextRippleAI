import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

/** Conversations for a document, optionally just those anchored to one block. */
export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const anchorBlockId = new URL(request.url).searchParams.get('anchor') ?? undefined;

    return NextResponse.json({
      conversations: await getStore().listConversations(id, { anchorBlockId }),
    });
  } catch (error) {
    return handleError(error);
  }
}
