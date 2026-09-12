import { NextResponse } from 'next/server';

import { BlockNotFoundError } from '@/ai/context-builder';
import {
  ConversationNotFoundError,
  DocumentNotFoundError,
  RevisionConflictError,
} from '@/store';

/**
 * Authentication arrives with the OIDC provider in a later milestone. Until
 * then every change is attributed to the single local author, so the ledger's
 * author_id column is populated from day one.
 */
export const CURRENT_USER_ID = 'usr_local';

export function handleError(error: unknown): NextResponse {
  if (error instanceof DocumentNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ConversationNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof BlockNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof RevisionConflictError) {
    return NextResponse.json(
      { error: error.message, expected: error.expected, actual: error.actual },
      { status: 409 },
    );
  }
  console.error(error);
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return NextResponse.json({ error: message }, { status: 500 });
}
