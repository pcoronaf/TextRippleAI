import { NextResponse } from 'next/server';

import { refreshIndex } from '@/server/indexer';
import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

// Indexing a long manuscript is many model calls; give it room.
export const maxDuration = 300;

/** What the index holds and what has gone out of date. */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    return NextResponse.json(await getStore().indexStatus(id));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Refresh whatever is stale.
 *
 * Explicit by design: nothing re-indexes on its own, so the cost of keeping the
 * index current is always something the author asked for.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    return NextResponse.json(
      await refreshIndex(id, {
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        embeddings: body.embeddings,
        summaries: body.summaries,
        semanticUnits: body.semanticUnits,
      }),
    );
  } catch (error) {
    return handleError(error);
  }
}
