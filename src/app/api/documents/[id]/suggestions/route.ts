import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';
import type { SuggestionStatus } from '@/core/types';

type Context = { params: Promise<{ id: string }> };

const STATUSES: SuggestionStatus[] = [
  'generated',
  'discussed',
  'revised',
  'accepted',
  'rejected',
];

/** Proposals for a document, optionally scoped to a block or to some statuses. */
export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;

    const blockId = query.get('blockId') ?? undefined;
    const requested = query.getAll('status').filter((value): value is SuggestionStatus =>
      STATUSES.includes(value as SuggestionStatus),
    );

    return NextResponse.json({
      suggestions: await getStore().listSuggestions(id, {
        blockId,
        statuses: requested.length > 0 ? requested : undefined,
      }),
    });
  } catch (error) {
    return handleError(error);
  }
}
