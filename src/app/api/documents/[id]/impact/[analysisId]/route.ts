import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; analysisId: string }> };

/** One briefing with its findings. */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id, analysisId } = await params;
    const found = await getStore().getImpactAnalysis(id, analysisId);

    if (!found) return NextResponse.json({ error: 'Analysis not found' }, { status: 404 });
    return NextResponse.json(found);
  } catch (error) {
    return handleError(error);
  }
}
