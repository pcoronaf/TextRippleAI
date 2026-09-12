import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';

type Context = { params: Promise<{ id: string; suggestionId: string }> };

/**
 * Resolve a proposal.
 *
 * `accept` is the only action that touches the document, and it does so in one
 * operation that also writes the ledger entry recording where the text came
 * from. `reject` and `discuss` leave the document untouched by construction -
 * there is no path from here to the content.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id, suggestionId } = await params;
    const body = await request.json().catch(() => ({}));
    const action = body.action;
    const store = getStore();

    if (action === 'accept') {
      if (typeof body.expectedRevision !== 'number') {
        return NextResponse.json(
          { error: 'expectedRevision is required when accepting a suggestion' },
          { status: 400 },
        );
      }

      const result = await store.acceptSuggestion(id, suggestionId, {
        acceptedBy: CURRENT_USER_ID,
        expectedRevision: body.expectedRevision,
      });
      return NextResponse.json(result);
    }

    if (action === 'reject' || action === 'discuss') {
      const suggestion = await store.setSuggestionStatus(id, suggestionId, {
        status: action === 'reject' ? 'rejected' : 'discussed',
        resolvedBy: CURRENT_USER_ID,
      });
      return NextResponse.json({ suggestion });
    }

    return NextResponse.json(
      { error: 'action must be one of: accept, reject, discuss' },
      { status: 400 },
    );
  } catch (error) {
    return handleError(error);
  }
}
