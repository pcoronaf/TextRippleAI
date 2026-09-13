import { NextResponse } from 'next/server';

import { ImpactNotActionableError, propagateImpact } from '@/server/propagate';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; impactId: string }> };

export const maxDuration = 120;

/**
 * Draft an edit that resolves one finding.
 *
 * The result is an ordinary suggestion: inert until the author accepts it,
 * reviewed as a diff, applied through the same path as every other AI edit.
 * Being machine-identified earns it no shortcut into the document.
 */
export async function POST(_request: Request, { params }: Context) {
  try {
    const { id, impactId } = await params;
    return NextResponse.json(await propagateImpact(id, impactId));
  } catch (error) {
    if (error instanceof ImpactNotActionableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return handleError(error);
  }
}
