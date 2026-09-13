import { NextResponse } from 'next/server';

import { detectDecisionConflicts, searchDecisions } from '@/core/decisions';
import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';
import type { DecisionScope, DecisionStatus } from '@/core/types';

type Context = { params: Promise<{ id: string }> };

const STATUSES: DecisionStatus[] = ['accepted', 'superseded', 'retired'];

function readScope(value: unknown): DecisionScope {
  const scope = value as Partial<DecisionScope> | undefined;
  if (scope?.type === 'node' || scope?.type === 'from_node') {
    if (typeof scope.nodeId === 'string' && scope.nodeId) {
      return { type: scope.type, nodeId: scope.nodeId };
    }
  }
  return { type: 'document' };
}

/** Decisions, with any contradictions between the ones in force. */
export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;

    const requested = query.getAll('status').filter((value): value is DecisionStatus =>
      STATUSES.includes(value as DecisionStatus),
    );

    const decisions = await getStore().listDecisions(id, {
      statuses: requested.length > 0 ? requested : undefined,
    });

    const search = query.get('q');
    return NextResponse.json({
      decisions: search ? searchDecisions(decisions, search) : decisions,
      conflicts: detectDecisionConflicts(decisions),
    });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Record a decision.
 *
 * It may come from a conversation, from refusing an impact finding, or from
 * nowhere but the author's own judgement. Recording one never edits the
 * document; its effect is on what the system proposes next.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const title = String(body.title ?? '').trim();
    if (!title) return NextResponse.json({ error: 'A title is required' }, { status: 400 });

    const source =
      body.source === 'conversation' || body.source === 'impact_review' ? body.source : 'manual';

    const decision = await getStore().createDecision(id, {
      title,
      description: String(body.description ?? '').trim(),
      scope: readScope(body.scope),
      source,
      createdBy: CURRENT_USER_ID,
      suppressBlockId: typeof body.suppressBlockId === 'string' ? body.suppressBlockId : null,
      suppressTerms: Array.isArray(body.suppressTerms)
        ? body.suppressTerms.filter((term: unknown) => typeof term === 'string')
        : [],
      suppressImpactType:
        typeof body.suppressImpactType === 'string' ? body.suppressImpactType : null,
      sourceImpactId: typeof body.sourceImpactId === 'string' ? body.sourceImpactId : null,
      sourceConversationId:
        typeof body.sourceConversationId === 'string' ? body.sourceConversationId : null,
      supersedesDecisionId:
        typeof body.supersedesDecisionId === 'string' ? body.supersedesDecisionId : null,
    });

    return NextResponse.json({ decision }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
