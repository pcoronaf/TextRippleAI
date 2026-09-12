/**
 * What a set of changed blocks invalidates.
 *
 * The spec's rule, verbatim:
 *
 *     paragraph        = current
 *     section summary  = stale
 *     chapter summary  = potentially stale
 *     document summary = potentially stale
 *
 * Nothing is regenerated here. Invalidation is cheap and immediate; recomputing
 * is lazy and explicit.
 */

import { enclosingHeadings } from './document';
import type { DocumentContent } from './types';

export interface InvalidationPlan {
  /** Blocks whose embeddings no longer describe their text. */
  staleBlockIds: string[];
  /** Section headings whose summary is definitely out of date. */
  staleSummaryNodeIds: string[];
  /** Chapter headings whose summary may be out of date. */
  potentiallyStaleSummaryNodeIds: string[];
  /** Whether the document brief should be marked potentially stale. */
  documentSummaryAffected: boolean;
}

export function planInvalidation(
  content: DocumentContent,
  changedBlockIds: readonly string[],
): InvalidationPlan {
  if (changedBlockIds.length === 0) {
    return {
      staleBlockIds: [],
      staleSummaryNodeIds: [],
      potentiallyStaleSummaryNodeIds: [],
      documentSummaryAffected: false,
    };
  }

  const enclosing = enclosingHeadings(content);
  const sections = new Set<string>();
  const chapters = new Set<string>();

  for (const blockId of changedBlockIds) {
    const parents = enclosing.get(blockId);
    if (!parents) continue;
    if (parents.sectionId) sections.add(parents.sectionId);
    if (parents.chapterId) chapters.add(parents.chapterId);
  }

  // A block sitting directly under a chapter heading, with no subsection
  // between, makes that chapter's summary definitely stale rather than merely
  // suspect. Where the two sets overlap, the stronger verdict wins.
  for (const id of sections) chapters.delete(id);

  return {
    staleBlockIds: [...new Set(changedBlockIds)],
    staleSummaryNodeIds: [...sections],
    potentiallyStaleSummaryNodeIds: [...chapters],
    documentSummaryAffected: true,
  };
}
