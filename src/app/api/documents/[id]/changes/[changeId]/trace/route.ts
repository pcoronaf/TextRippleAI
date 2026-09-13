import { NextResponse } from 'next/server';

import { traceChange } from '@/server/propagate';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; changeId: string }> };

/**
 * Why this paragraph reads the way it does.
 *
 * Walks the stored links back from a ledger entry: the proposal it came from,
 * the finding that proposal resolved, the analysis that produced the finding,
 * and the original changes whose consequences it addresses.
 */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id, changeId } = await params;
    const provenance = await traceChange(id, changeId);

    if (!provenance) return NextResponse.json({ error: 'Change not found' }, { status: 404 });
    return NextResponse.json(provenance);
  } catch (error) {
    return handleError(error);
  }
}
