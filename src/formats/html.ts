/**
 * HTML -> canonical document JSON.
 *
 * Both DOCX import (via mammoth) and Markdown import (via marked) funnel
 * through HTML, so this is the single place where external markup is mapped
 * onto the node types the editor understands. Anything unrecognised degrades
 * to a paragraph rather than being dropped silently.
 */

import { parse, type HTMLElement, type Node as ParsedNode } from 'node-html-parser';

import { ensureNodeIds } from '@/core/document';
import type { ContentNode, DocumentContent, Mark } from '@/core/types';

/** Inline tags that become marks on the text they wrap. */
const MARK_FOR_TAG: Record<string, string> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const isElement = (node: ParsedNode): node is HTMLElement =>
  (node as HTMLElement).tagName !== undefined && (node as HTMLElement).tagName !== null;

const tagOf = (element: HTMLElement): string => element.tagName.toLowerCase();

/** Collect inline content, accumulating marks down the tree. */
function inlineContent(node: ParsedNode, marks: Mark[] = []): ContentNode[] {
  if (!isElement(node)) {
    const text = decodeEntities(node.rawText ?? '').replace(/\s+/g, ' ');
    if (!text) return [];
    return [{ type: 'text', text, ...(marks.length ? { marks: [...marks] } : {}) }];
  }

  const tag = tagOf(node);

  if (tag === 'br') return [{ type: 'hardBreak' }];
  if (tag === 'img') {
    const alt = node.getAttribute('alt');
    // Images are not part of the M0 baseline; keep the alt text so no prose
    // is lost on a round trip.
    return alt ? [{ type: 'text', text: alt }] : [];
  }

  const next = [...marks];
  const markType = MARK_FOR_TAG[tag];
  if (markType && !next.some((mark) => mark.type === markType)) next.push({ type: markType });
  if (tag === 'a') {
    const href = node.getAttribute('href');
    if (href) next.push({ type: 'link', attrs: { href } });
  }

  return node.childNodes.flatMap((child) => inlineContent(child, next));
}

function paragraph(children: ContentNode[]): ContentNode {
  return { type: 'paragraph', ...(children.length ? { content: children } : {}) };
}

/** Ensure a container that requires block content has at least one paragraph. */
function asBlocks(element: HTMLElement): ContentNode[] {
  const blocks = element.childNodes.flatMap(blockContent);
  return blocks.length > 0 ? blocks : [paragraph([])];
}

function blockContent(node: ParsedNode): ContentNode[] {
  if (!isElement(node)) {
    const text = decodeEntities(node.rawText ?? '').trim();
    return text ? [paragraph([{ type: 'text', text }])] : [];
  }

  const tag = tagOf(node);

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return [
        {
          type: 'heading',
          attrs: { level: Number(tag.slice(1)) },
          content: node.childNodes.flatMap((child) => inlineContent(child)),
        },
      ];

    case 'p':
      return [paragraph(node.childNodes.flatMap((child) => inlineContent(child)))];

    case 'ul':
    case 'ol':
      return [
        {
          type: tag === 'ul' ? 'bulletList' : 'orderedList',
          content: node.childNodes
            .filter((child): child is HTMLElement => isElement(child) && tagOf(child) === 'li')
            .map((item) => ({ type: 'listItem', content: asBlocks(item) })),
        },
      ];

    case 'li':
      return [{ type: 'listItem', content: asBlocks(node) }];

    case 'blockquote':
      return [{ type: 'blockquote', content: asBlocks(node) }];

    case 'pre':
      return [
        {
          type: 'codeBlock',
          content: [{ type: 'text', text: decodeEntities(node.rawText ?? '') }],
        },
      ];

    case 'hr':
      return [{ type: 'horizontalRule' }];

    case 'table':
      return [buildTable(node)];

    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'div':
    case 'section':
    case 'article':
    case 'body':
    case 'main':
      return node.childNodes.flatMap(blockContent);

    default: {
      // Unknown element: keep its text as a paragraph rather than lose it.
      const inline = node.childNodes.flatMap((child) => inlineContent(child));
      return inline.length ? [paragraph(inline)] : [];
    }
  }
}

function buildTable(element: HTMLElement): ContentNode {
  const rows = element.querySelectorAll('tr').map((row) => ({
    type: 'tableRow',
    content: row.childNodes
      .filter((cell): cell is HTMLElement => isElement(cell) && ['td', 'th'].includes(tagOf(cell)))
      .map((cell) => ({
        type: tagOf(cell) === 'th' ? 'tableHeader' : 'tableCell',
        attrs: {
          colspan: Number(cell.getAttribute('colspan') ?? 1),
          rowspan: Number(cell.getAttribute('rowspan') ?? 1),
        },
        content: asBlocks(cell),
      })),
  }));

  return { type: 'table', content: rows.filter((row) => (row.content?.length ?? 0) > 0) };
}

/** Parse an HTML fragment into canonical document JSON with persistent IDs. */
export function htmlToContent(html: string): DocumentContent {
  const root = parse(html, { blockTextElements: { pre: true, code: true } });
  const blocks = root.childNodes.flatMap(blockContent);

  return ensureNodeIds({
    type: 'doc',
    content: blocks.length > 0 ? blocks : [paragraph([])],
  }).content;
}
