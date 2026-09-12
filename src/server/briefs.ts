/**
 * The hierarchical summaries that cover a given block.
 *
 * Only summaries the index considers current are handed to the Context Builder.
 * A stale brief describes text that no longer exists, and feeding one to the
 * model is worse than sending nothing - the answer would be confidently wrong
 * rather than visibly incomplete.
 */

import { enclosingHeadings } from '@/core/document';
import type { DocumentContent } from '@/core/types';
import { getStore } from '@/store';

export interface Briefs {
  document?: string;
  chapter?: string;
  section?: string;
}

export async function briefsFor(
  documentId: string,
  content: DocumentContent,
  blockId: string,
): Promise<Briefs> {
  const summaries = await getStore().listSummaries(documentId, { statuses: ['current'] });
  if (summaries.length === 0) return {};

  const { sectionId, chapterId } = enclosingHeadings(content).get(blockId) ?? {
    sectionId: null,
    chapterId: null,
  };

  const find = (type: 'document' | 'chapter' | 'section', nodeId: string | null) =>
    summaries.find((entry) => entry.summaryType === type && entry.nodeId === nodeId)?.content;

  return {
    document: find('document', null),
    chapter: chapterId ? find('chapter', chapterId) : undefined,
    section: sectionId ? find('section', sectionId) : undefined,
  };
}
