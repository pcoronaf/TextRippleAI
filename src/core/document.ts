/**
 * Operations over the canonical document representation (Tiptap/ProseMirror
 * JSON): identity assignment, flattening, outline extraction.
 */

import { newNodeId } from './ids';
import type { ContentNode, DocumentContent, FlatBlock } from './types';

/** Node types that carry a persistent identifier. */
export const ID_NODE_TYPES = new Set([
  'heading',
  'paragraph',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'image',
  'horizontalRule',
]);

/**
 * Node types that hold inline text directly. These are the units the Change
 * Aggregator compares; container nodes (lists, tables, cells) delegate their
 * text to the paragraphs nested inside them.
 */
export const TEXT_BLOCK_TYPES = new Set(['paragraph', 'heading', 'codeBlock']);

/** Concatenated plain text of a node and its descendants. */
export function nodeText(node: ContentNode): string {
  if (typeof node.text === 'string') return node.text;
  if (!node.content) return '';
  return node.content.map(nodeText).join('');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Assign persistent IDs to every node that lacks one, and re-assign IDs that
 * are duplicated.
 *
 * Duplicates arise routinely: splitting a paragraph copies its attributes onto
 * both halves, and pasting a block copies its ID. The node appearing first in
 * reading order keeps the ID - so splitting a paragraph leaves the opening
 * half with its original identity and gives the remainder a new one. Untouched
 * nodes are never renumbered.
 *
 * Returns a new document; the input is not mutated.
 */
export function ensureNodeIds(input: DocumentContent): {
  content: DocumentContent;
  assigned: number;
} {
  const content = clone(input);
  const seen = new Set<string>();
  let assigned = 0;

  const visit = (node: ContentNode): void => {
    if (ID_NODE_TYPES.has(node.type)) {
      const current = node.attrs?.id;
      const isUsable = typeof current === 'string' && current.length > 0 && !seen.has(current);
      if (isUsable) {
        seen.add(current as string);
      } else {
        const id = newNodeId(node.type);
        node.attrs = { ...(node.attrs ?? {}), id };
        seen.add(id);
        assigned++;
      }
    }
    node.content?.forEach(visit);
  };

  content.content?.forEach(visit);
  return { content, assigned };
}

/**
 * Flatten the document into text-bearing blocks in reading order.
 *
 * `position` is an ordering hint for display and diff alignment only. Identity
 * always comes from `id`.
 */
export function flattenBlocks(content: DocumentContent): FlatBlock[] {
  const blocks: FlatBlock[] = [];

  const visit = (node: ContentNode, parentId: string | null): void => {
    const id = typeof node.attrs?.id === 'string' ? (node.attrs.id as string) : null;

    if (TEXT_BLOCK_TYPES.has(node.type) && id) {
      blocks.push({
        id,
        type: node.type,
        text: nodeText(node),
        position: blocks.length,
        parentId,
        attrs: { ...(node.attrs ?? {}) },
      });
    }

    node.content?.forEach((child) => visit(child, id ?? parentId));
  };

  content.content?.forEach((node) => visit(node, null));
  return blocks;
}

/** Map of block ID to block, for O(1) lookup during change aggregation. */
export function blockMap(content: DocumentContent): Map<string, FlatBlock> {
  return new Map(flattenBlocks(content).map((block) => [block.id, block]));
}

export interface OutlineItem {
  id: string;
  level: number;
  title: string;
  position: number;
}

/** Heading tree used by the document outline pane. */
export function buildOutline(content: DocumentContent): OutlineItem[] {
  return flattenBlocks(content)
    .filter((block) => block.type === 'heading')
    .map((block) => ({
      id: block.id,
      level: typeof block.attrs.level === 'number' ? (block.attrs.level as number) : 1,
      title: block.text.trim() || 'Untitled heading',
      position: block.position,
    }));
}

/**
 * The nearest preceding level-1 heading for each block - the "chapter" a change
 * belongs to when reporting changes since a checkpoint.
 */
export function chapterIndex(content: DocumentContent): Map<string, OutlineItem | null> {
  const index = new Map<string, OutlineItem | null>();
  let current: OutlineItem | null = null;

  for (const block of flattenBlocks(content)) {
    if (block.type === 'heading') {
      const level = typeof block.attrs.level === 'number' ? (block.attrs.level as number) : 1;
      if (level === 1) {
        current = { id: block.id, level, title: block.text.trim() || 'Untitled chapter', position: block.position };
        index.set(block.id, current);
        continue;
      }
    }
    index.set(block.id, current);
  }

  return index;
}

/** Document title derived from the first level-1 heading, when present. */
export function inferTitle(content: DocumentContent, fallback = 'Untitled document'): string {
  const outline = buildOutline(content);
  const first = outline.find((item) => item.level === 1) ?? outline[0];
  return first?.title ?? fallback;
}

/** An empty document containing a single paragraph, ready to type into. */
export function emptyDocument(): DocumentContent {
  return ensureNodeIds({
    type: 'doc',
    content: [{ type: 'paragraph', content: [] }],
  }).content;
}

