import { NextResponse } from 'next/server';

import { search, type RetrievalMode } from '@/server/retrieval';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

const MODES: RetrievalMode[] = ['hybrid', 'text', 'semantic'];

/** Hybrid retrieval: full-text and vector search, fused. */
export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;

    const requested = query.get('mode') as RetrievalMode | null;
    const mode = requested && MODES.includes(requested) ? requested : 'hybrid';
    const limit = Number(query.get('limit') ?? 10);

    return NextResponse.json(
      await search(id, query.get('q') ?? '', { mode, limit: Number.isFinite(limit) ? limit : 10 }),
    );
  } catch (error) {
    return handleError(error);
  }
}
