/**
 * Applying a replacement to a block.
 *
 * The unit of modification is the block: a proposal replaces a whole paragraph,
 * because that is the smallest unit whose meaning stands on its own and the
 * largest one a reader reviews at a glance.
 *
 * Inline formatting is preserved on whatever prefix and suffix the replacement
 * leaves untouched - a targeted rewrite of one clause keeps the bold run and
 * the hyperlink at the other end of the paragraph. Only the span that actually
 * changed becomes plain text, carrying the marks that were in force where it
 * begins.
 */

import { TEXT_BLOCK_TYPES, nodeText } from './document';
import type { ContentNode, DocumentContent, Mark } from './types';

export class ApplyTargetNotFoundError extends Error {
  constructor(readonly blockId: string) {
    super(`Block ${blockId} is not part of this document`);
    this.name = 'ApplyTargetNotFoundError';
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Length of the longest shared prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index++;
  return index;
}

/** Length of the longest shared suffix, not overlapping the given prefix. */
function commonSuffix(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let index = 0;
  while (index < limit && a[a.length - 1 - index] === b[b.length - 1 - index]) index++;
  return index;
}

/** Inline nodes covering the character range [start, end), marks preserved. */
function sliceInline(nodes: ContentNode[], start: number, end: number): ContentNode[] {
  if (end <= start) return [];

  const out: ContentNode[] = [];
  let offset = 0;

  for (const node of nodes) {
    if (typeof node.text !== 'string') {
      // Zero-width inline nodes (a hard break, say) sit between characters.
      if (offset > start && offset < end) out.push(clone(node));
      continue;
    }

    const nodeStart = offset;
    const nodeEnd = offset + node.text.length;
    offset = nodeEnd;

    const from = Math.max(start, nodeStart);
    const to = Math.min(end, nodeEnd);
    if (to <= from) continue;

    out.push({
      ...clone(node),
      text: node.text.slice(from - nodeStart, to - nodeStart),
    });
  }

  return out;
}

/** Marks in force at a character offset - what a replacement inherits. */
function marksAt(nodes: ContentNode[], offset: number): Mark[] | undefined {
  let cursor = 0;
  let last: Mark[] | undefined;

  for (const node of nodes) {
    if (typeof node.text !== 'string') continue;
    const start = cursor;
    const end = cursor + node.text.length;
    cursor = end;

    if (offset > start && offset <= end) last = node.marks;
    if (offset < end) break;
  }

  return last ? clone(last) : undefined;
}

/**
 * Rebuild a block's inline content so its text reads as `nextText`, keeping the
 * formatting of the untouched prefix and suffix.
 */
export function spliceInlineText(
  inline: ContentNode[],
  oldText: string,
  nextText: string,
): ContentNode[] {
  if (oldText === nextText) return clone(inline);
  if (!nextText) return [];

  const prefix = commonPrefix(oldText, nextText);
  const suffix = commonSuffix(oldText, nextText, prefix);
  const middle = nextText.slice(prefix, nextText.length - suffix);

  const head = sliceInline(inline, 0, prefix);
  const tail = sliceInline(inline, oldText.length - suffix, oldText.length);

  const body: ContentNode[] = [];
  if (middle) {
    const marks = marksAt(inline, prefix);
    body.push({ type: 'text', text: middle, ...(marks?.length ? { marks } : {}) });
  }

  return [...head, ...body, ...tail];
}

/**
 * Replace the text of one block.
 *
 * The block keeps its identity and its node attributes - a rewritten paragraph
 * is the same paragraph, which is what makes the change traceable afterwards.
 * Returns a new document; the input is not mutated.
 */
export function replaceBlockText(
  content: DocumentContent,
  blockId: string,
  nextText: string,
): DocumentContent {
  const next = clone(content);
  let found = false;

  const visit = (node: ContentNode): void => {
    if (found) return;

    if (TEXT_BLOCK_TYPES.has(node.type) && node.attrs?.id === blockId) {
      found = true;
      const inline = node.content ?? [];
      const replacement = spliceInlineText(inline, nodeText(node), nextText);
      if (replacement.length > 0) node.content = replacement;
      else delete node.content;
      return;
    }

    node.content?.forEach(visit);
  };

  next.content?.forEach(visit);
  if (!found) throw new ApplyTargetNotFoundError(blockId);

  return next;
}
