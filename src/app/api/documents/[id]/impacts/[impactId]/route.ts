import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';
import type { ImpactStatusValue } from '@/core/types';

type Context = { params: Promise<{ id: string; impactId: string }> };

/**
 * Resolutions available in M5. `generate_suggestion` marks a finding as one the
 * author wants acted on; producing the proposal is M6, and it will go through
 * the suggestion workflow rather than touching the document here.
 */
const ALLOWED: ImpactStatusValue[] = [
  'pending',
  'dismissed',
  'accepted_no_change',
  'needs_review',
  'generate_suggestion',
];

export async function POST(request: Request, { params }: Context) {
  try {
    const { id, impactId } = await params;
    const body = await request.json().catch(() => ({}));

    if (!ALLOWED.includes(body.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${ALLOWED.join(', ')}` },
        { status: 400 },
      );
    }

    const impact = await getStore().setImpactStatus(id, impactId, {
      status: body.status,
      resolvedBy: CURRENT_USER_ID,
    });

    return NextResponse.json({ impact });
  } catch (error) {
    return handleError(error);
  }
}
