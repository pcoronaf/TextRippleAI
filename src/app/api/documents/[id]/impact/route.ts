import { NextResponse } from 'next/server';

import { analyseImpact, NothingToAnalyseError } from '@/server/impact';
import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

// Retrieval plus one reasoning call over a long document.
export const maxDuration = 300;

/** Previous analyses, newest first. */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    return NextResponse.json({ analyses: await getStore().listImpactAnalyses(id) });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Analyse accumulated changes.
 *
 * Explicit by design, and incapable of editing: the result is a briefing, and
 * acting on it is a separate decision the author makes per finding.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const result = await analyseImpact(id, {
      sinceCheckpointId: typeof body.since === 'string' ? body.since : null,
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      candidateLimit: typeof body.candidateLimit === 'number' ? body.candidateLimit : undefined,
      includeTrivial: body.includeTrivial === true,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NothingToAnalyseError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return handleError(error);
  }
}
