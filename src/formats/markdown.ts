/** Markdown and plain-text import/export. */

import { htmlToContent } from './html';
import type { ContentNode, DocumentContent } from '@/core/types';
import { ensureNodeIds } from '@/core/document';

/** Markdown -> canonical document JSON, via HTML. */
export async function markdownToContent(markdown: string): Promise<DocumentContent> {
  const { marked } = await import('marked');
  const html = await marked.parse(markdown, { async: true });
  return htmlToContent(html);
}

/** Plain text -> canonical document JSON: blank lines separate paragraphs. */
export function textToContent(text: string): DocumentContent {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return ensureNodeIds({
    type: 'doc',
    content:
      paragraphs.length > 0
        ? paragraphs.map((paragraph) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: paragraph.replace(/\n/g, ' ') }],
          }))
        : [{ type: 'paragraph' }],
  }).content;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function inlineToMarkdown(nodes: ContentNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n';
      if (typeof node.text !== 'string') return '';

      let text = escapeMarkdown(node.text);
      const marks = node.marks ?? [];
      const has = (type: string) => marks.some((mark) => mark.type === type);

      if (has('code')) text = `\`${node.text}\``;
      if (has('bold')) text = `**${text}**`;
      if (has('italic')) text = `*${text}*`;
      if (has('strike')) text = `~~${text}~~`;

      const link = marks.find((mark) => mark.type === 'link');
      if (link && typeof link.attrs?.href === 'string') text = `[${text}](${link.attrs.href})`;

      return text;
    })
    .join('');
}

function blockToMarkdown(node: ContentNode, depth = 0, marker?: (index: number) => string): string[] {
  const indent = '  '.repeat(depth);

  switch (node.type) {
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return [`${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${inlineToMarkdown(node.content ?? [])}`];
    }

    case 'paragraph': {
      const text = inlineToMarkdown(node.content ?? []);
      return [marker ? `${indent}${marker(0)}${text}` : text];
    }

    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      return (node.content ?? []).flatMap((item, index) =>
        (item.content ?? []).flatMap((child, childIndex) =>
          blockToMarkdown(
            child,
            depth,
            childIndex === 0 ? () => (ordered ? `${index + 1}. ` : '- ') : undefined,
          ),
        ),
      );
    }

    case 'blockquote':
      return (node.content ?? [])
        .flatMap((child) => blockToMarkdown(child, depth))
        .map((line) => `> ${line}`);

    case 'codeBlock':
      return ['```', (node.content ?? []).map((child) => child.text ?? '').join(''), '```'];

    case 'horizontalRule':
      return ['---'];

    case 'table': {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? []).map((child) => inlineToMarkdown(child.content ?? [])).join(' '),
        ),
      );
      if (rows.length === 0) return [];
      const [header, ...body] = rows;
      return [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...body.map((cells) => `| ${cells.join(' | ')} |`),
      ];
    }

    default:
      return (node.content ?? []).flatMap((child) => blockToMarkdown(child, depth));
  }
}

/** Canonical document JSON -> Markdown. */
export function contentToMarkdown(content: DocumentContent): string {
  return content.content
    .flatMap((node) => blockToMarkdown(node))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
