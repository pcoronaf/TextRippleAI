/**
 * Resolving which decisions apply.
 *
 * The matching itself is pure (`core/decisions.ts`); this layer fetches.
 */

import { decisionsFor } from '@/core/decisions';
import { enclosingHeadings, flattenBlocks } from '@/core/document';
import type { DecisionRecord, DocumentContent } from '@/core/types';
import { getStore } from '@/store';

/** Decisions in force for one passage, newest first. */
export async function decisionsForBlock(
  documentId: string,
  content: DocumentContent,
  blockId: string,
): Promise<DecisionRecord[]> {
  const decisions = await getStore().listDecisions(documentId, { statuses: ['accepted'] });
  if (decisions.length === 0) return [];

  return decisionsFor(decisions, blockId, flattenBlocks(content), enclosingHeadings(content));
}

/** The shape the Context Builder takes. */
export const asContextDecisions = (decisions: readonly DecisionRecord[]) =>
  decisions.map((decision) => ({ title: decision.title, description: decision.description }));
