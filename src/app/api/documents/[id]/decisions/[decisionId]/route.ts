import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';
import type { DecisionStatus } from '@/core/types';

type Context = { params: Promise<{ id: string; decisionId: string }> };

const STATUSES: DecisionStatus[] = ['accepted', 'superseded', 'retired'];

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id, decisionId } = await params;
    const decision = await getStore().getDecision(id, decisionId);

    if (!decision) return NextResponse.json({ error: 'Decision not found' }, { status: 404 });
    return NextResponse.json({ decision });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Edit or retire a decision.
 *
 * Never deleted: the reasoning behind a choice stays readable even once the
 * choice itself has moved on.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id, decisionId } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.status !== undefined && !STATUSES.includes(body.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${STATUSES.join(', ')}` },
        { status: 400 },
      );
    }

    const decision = await getStore().updateDecision(id, decisionId, {
      title: typeof body.title === 'string' ? body.title : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      status: body.status,
    });

    return NextResponse.json({ decision });
  } catch (error) {
    return handleError(error);
  }
}
