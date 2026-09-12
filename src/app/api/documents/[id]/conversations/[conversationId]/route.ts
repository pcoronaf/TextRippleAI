import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; conversationId: string }> };

/** One conversation with its turns, so a reload resumes where it left off. */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id, conversationId } = await params;
    const store = getStore();

    const conversation = await store.getConversation(id, conversationId);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return NextResponse.json({
      conversation,
      messages: await store.listMessages(id, conversationId),
    });
  } catch (error) {
    return handleError(error);
  }
}
