/** Record construction shared by every store implementation. */

import { newChangeId } from '@/core/ids';
import { contentHash } from '@/core/hash';
import { flattenBlocks } from '@/core/document';
import type {
  ChangeRecord,
  ChangeSource,
  DocumentContent,
  DocumentNodeRecord,
  DraftChange,
} from '@/core/types';

/**
 * Derive node records from document content.
 *
 * A node's `revision` is the revision at which its content last changed - not
 * the document revision - so an untouched paragraph keeps both its ID and its
 * revision when its neighbours are edited.
 */
export function buildNodeRecords(
  documentId: string,
  content: DocumentContent,
  revision: number,
  previous: DocumentNodeRecord[] = [],
): DocumentNodeRecord[] {
  const before = new Map(previous.map((node) => [node.id, node]));
  const now = new Date().toISOString();

  return flattenBlocks(content).map((block) => {
    const hash = contentHash(block.text);
    const existing = before.get(block.id);
    const unchanged = existing !== undefined && existing.contentHash === hash;

    return {
      id: block.id,
      documentId,
      parentId: block.parentId,
      type: block.type,
      position: block.position,
      revision: unchanged ? existing.revision : revision,
      text: block.text,
      contentHash: hash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: unchanged ? existing.updatedAt : now,
    };
  });
}

/** Turn drafts from the Change Aggregator into committed ledger entries. */
export function toChangeRecords(
  documentId: string,
  drafts: DraftChange[],
  meta: { authorId: string; source: ChangeSource; revision: number },
): ChangeRecord[] {
  const createdAt = new Date().toISOString();

  return drafts.map((draft) => ({
    ...draft,
    id: newChangeId(),
    documentId,
    authorId: meta.authorId,
    source: meta.source,
    revision: meta.revision,
    checkpointId: null,
    impactStatus: 'pending' as const,
    prompt: null,
    model: null,
    suggestionId: null,
    createdAt,
  }));
}
