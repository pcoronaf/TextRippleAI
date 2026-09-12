import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; suggestionId: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id, suggestionId } = await params;
    const suggestion = await getStore().getSuggestion(id, suggestionId);

    if (!suggestion) {
      return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
    }
    return NextResponse.json({ suggestion });
  } catch (error) {
    return handleError(error);
  }
}
