/**
 * Change clustering.
 *
 * Fifty small edits may represent only three conceptual changes. Sweeping one
 * term through a chapter produces a ledger entry per paragraph, but there is
 * one thing to reason about, and reasoning about it fifty times would be fifty
 * times the cost for a worse answer.
 *
 * Clustering is local and free - no model call.
 */

import { isTrivial } from './classify';
import { diffWords } from './diff';
import type { ChangeClassification, ChangeRecord } from './types';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'has', 'have',
  'if', 'in', 'into', 'is', 'it', 'its', 'may', 'must', 'no', 'not', 'of', 'on', 'or', 'shall',
  'should', 'so', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'to', 'was', 'were', 'which', 'will', 'with', 'would',
]);

/** Meaningful words, lowercased and de-duplicated in order. */
export function contentWords(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter(
    (word) => word.length > 1 && !STOPWORDS.has(word),
  );
  return [...new Set(words)];
}

export interface ChangeCluster {
  id: string;
  changeIds: string[];
  /** The passages this change touched. A block belongs to exactly one cluster. */
  blockIds: string[];
  /** Most common classification among the members. */
  classification: ChangeClassification;
  /** Human-readable description of the conceptual change. */
  label: string;
  /**
   * The vocabulary shift. `removed` is what to search the rest of the document
   * for: other places still saying what this change stopped saying.
   */
  terms: { removed: string[]; added: string[] };
  /**
   * Text of the changed passages as each edit left them, for semantic
   * retrieval. This is history, not the present: a passage edited again since
   * has moved on, so nothing may show these as what the document now says.
   */
  afterText: string[];
  size: number;
}

/** Words that a change took out and put in, ignoring filler. */
export function wordShift(before: string, after: string): { removed: string[]; added: string[] } {
  const segments = diffWords(before, after);

  const removed = new Set<string>();
  const added = new Set<string>();

  for (const segment of segments) {
    if (segment.op === 'equal') continue;
    for (const word of contentWords(segment.value)) {
      (segment.op === 'delete' ? removed : added).add(word);
    }
  }

  // A word merely moved within the sentence is not a vocabulary change.
  for (const word of [...removed]) {
    if (added.has(word)) {
      removed.delete(word);
      added.delete(word);
    }
  }

  return { removed: [...removed], added: [...added] };
}

/** A focused swap is small on both sides - a term replaced, not a rewrite. */
const SWAP_LIMIT = 3;

/**
 * The sweep this change belongs to, or null if it is not a focused swap.
 *
 * The key is the vocabulary shift itself, so the same swap made in forty
 * paragraphs produces one key and therefore one conceptual change.
 */
function swapKey(shift: { removed: string[]; added: string[] }): string | null {
  const focused =
    shift.removed.length > 0 &&
    shift.removed.length <= SWAP_LIMIT &&
    shift.added.length <= SWAP_LIMIT;

  if (!focused) return null;
  return `swap:${[...shift.removed].sort().join('|')}=>${[...shift.added].sort().join('|')}`;
}

const quote = (words: string[]) => words.map((word) => `"${word}"`).join(', ');

export interface ClusterOptions {
  /** Typographical noise is excluded by default. */
  includeTrivial?: boolean;
}

/**
 * Group changes into the conceptual changes they represent.
 *
 * Two rules, in order:
 *
 * 1. A focused vocabulary swap clusters with every other change making the same
 *    swap, wherever it happened. This is the terminology sweep.
 * 2. Anything else clusters by block, so repeated work on one passage is one
 *    conceptual change rather than several.
 *
 * The rules are applied to a block's whole history since the review boundary,
 * not to each ledger entry on its own. A paragraph that was swept and then also
 * rewritten would otherwise land in two clusters at once, and downstream every
 * cluster speaks about its passages in the present tense - so one passage would
 * be described twice, in two different states, and at most one of them could be
 * true. A block therefore joins the sweep only when the sweep is all that
 * happened to it; anything more varied keeps the block whole.
 */
export function clusterChanges(
  changes: readonly ChangeRecord[],
  options: ClusterOptions = {},
): ChangeCluster[] {
  const considered = changes.filter(
    (change) => options.includeTrivial || !isTrivial(change.classification),
  );

  const shifts = new Map<string, { removed: string[]; added: string[] }>();
  const byBlock = new Map<string, ChangeRecord[]>();

  for (const change of considered) {
    shifts.set(change.id, wordShift(change.before, change.after));

    const bucket = byBlock.get(change.blockId);
    if (bucket) bucket.push(change);
    else byBlock.set(change.blockId, [change]);
  }

  const groups = new Map<string, ChangeRecord[]>();

  for (const [blockId, blockChanges] of byBlock) {
    const keys = new Set(blockChanges.map((change) => swapKey(shifts.get(change.id)!)));
    const single = keys.size === 1 ? [...keys][0] : null;
    const key = single ?? `block:${blockId}`;

    const bucket = groups.get(key);
    if (bucket) bucket.push(...blockChanges);
    else groups.set(key, [...blockChanges]);
  }

  return [...groups.entries()].map(([key, members]) => {
    const removed = new Set<string>();
    const added = new Set<string>();
    const counts = new Map<ChangeClassification, number>();

    for (const change of members) {
      const shift = shifts.get(change.id)!;
      shift.removed.forEach((word) => removed.add(word));
      shift.added.forEach((word) => added.add(word));
      counts.set(change.classification, (counts.get(change.classification) ?? 0) + 1);
    }

    const classification = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const terms = { removed: [...removed], added: [...added] };
    const blockIds = [...new Set(members.map((change) => change.blockId))];

    return {
      id: key,
      changeIds: members.map((change) => change.id),
      blockIds,
      classification,
      // A sweep is counted in passages, not in ledger entries: editing one
      // paragraph twice is one place, and saying "2 places" would overstate how
      // far through the document the change has reached.
      label: labelFor(key, terms, { entries: members.length, places: blockIds.length }),
      terms,
      afterText: members.map((change) => change.after).filter(Boolean),
      size: members.length,
    };
  })
  .sort((a, b) => b.size - a.size);
}

function labelFor(
  key: string,
  terms: { removed: string[]; added: string[] },
  size: { entries: number; places: number },
): string {
  if (key.startsWith('swap:')) {
    if (terms.removed.length && terms.added.length) {
      const places = size.places > 1 ? ` (${size.places} places)` : '';
      return `${quote(terms.removed)} → ${quote(terms.added)}${places}`;
    }
    if (terms.removed.length) return `Removed ${quote(terms.removed)}`;
    return `Added ${quote(terms.added)}`;
  }
  return size.entries > 1 ? `${size.entries} edits to one passage` : 'One passage rewritten';
}
