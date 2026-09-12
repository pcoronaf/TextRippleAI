/**
 * DOCX import and export - the M0 baseline.
 *
 * Supported both ways: headings, paragraphs, bold/italic/underline/strike,
 * inline code, hyperlinks, bulleted and numbered lists, tables, block quotes,
 * code blocks and horizontal rules.
 *
 * Deliberately out of the baseline (see docs/implementation-notes.md): images,
 * footnotes, comments, tracked changes and layout fidelity. Full Word fidelity
 * must not block the change-intelligence workflow, and the canonical
 * representation stays the internal JSON either way.
 */

import { htmlToContent } from './html';
import { flattenBlocks } from '@/core/document';
import type { ContentNode, DocumentContent } from '@/core/types';

const HEADING_LEVELS = [
  'Heading1',
  'Heading2',
  'Heading3',
  'Heading4',
  'Heading5',
  'Heading6',
] as const;

const ORDERED_LIST_REFERENCE = 'textripple-ordered';

/** DOCX -> canonical document JSON. */
export async function importDocx(buffer: Buffer): Promise<DocumentContent> {
  const mammoth = await import('mammoth');
  const convert = (mammoth as any).convertToHtml ?? (mammoth as any).default?.convertToHtml;
  const result = await convert({ buffer });
  return htmlToContent(result.value);
}

/** Canonical document JSON -> DOCX. */
export async function exportDocx(content: DocumentContent, title: string): Promise<Buffer> {
  const docx = await import('docx');
  const { Document, Packer } = docx;

  const children = content.content.flatMap((node) => renderBlock(node, docx, { listLevel: 0 }));

  const document = new Document({
    title,
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REFERENCE,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: 'decimal' as const,
            text: `%${level + 1}.`,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(document);
}

interface RenderContext {
  listLevel: number;
  bullet?: boolean;
  ordered?: boolean;
  quote?: boolean;
}

type DocxModule = typeof import('docx');

function renderBlock(node: ContentNode, docx: DocxModule, context: RenderContext): any[] {
  const { Paragraph, Table, TableRow, TableCell } = docx;

  switch (node.type) {
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return [
        new Paragraph({
          heading: HEADING_LEVELS[Math.min(Math.max(level, 1), 6) - 1] as any,
          children: renderInline(node.content ?? [], docx),
        }),
      ];
    }

    case 'paragraph':
      return [
        new Paragraph({
          children: renderInline(node.content ?? [], docx),
          ...(context.bullet ? { bullet: { level: context.listLevel } } : {}),
          ...(context.ordered
            ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: context.listLevel } }
            : {}),
          ...(context.quote ? { indent: { left: 720 } } : {}),
        }),
      ];

    case 'bulletList':
    case 'orderedList': {
      const nested: RenderContext = {
        listLevel: context.bullet || context.ordered ? context.listLevel + 1 : 0,
        bullet: node.type === 'bulletList',
        ordered: node.type === 'orderedList',
      };
      return (node.content ?? []).flatMap((item) => renderBlock(item, docx, nested));
    }

    case 'listItem':
      return (node.content ?? []).flatMap((child) => renderBlock(child, docx, context));

    case 'blockquote':
      return (node.content ?? []).flatMap((child) =>
        renderBlock(child, docx, { ...context, quote: true }),
      );

    case 'codeBlock':
      return [
        new Paragraph({
          children: [
            new docx.TextRun({
              text: (node.content ?? []).map((child) => child.text ?? '').join(''),
              font: 'Consolas',
            }),
          ],
        }),
      ];

    case 'horizontalRule':
      return [new Paragraph({ thematicBreak: true })];

    case 'table': {
      const rows = (node.content ?? []).map(
        (row) =>
          new TableRow({
            children: (row.content ?? []).map(
              (cell) =>
                new TableCell({
                  children: (cell.content ?? []).flatMap((child) =>
                    renderBlock(child, docx, { listLevel: 0 }),
                  ),
                }),
            ),
          }),
      );
      return rows.length > 0 ? [new Table({ rows })] : [];
    }

    default:
      return (node.content ?? []).flatMap((child) => renderBlock(child, docx, context));
  }
}

function renderInline(nodes: ContentNode[], docx: DocxModule): any[] {
  const { TextRun, ExternalHyperlink } = docx;

  // A run may be wrapped in a hyperlink, so the element type is not uniform.
  return nodes.flatMap((node): any[] => {
    if (node.type === 'hardBreak') return [new TextRun({ text: '', break: 1 })];
    if (typeof node.text !== 'string') return [];

    const marks = node.marks ?? [];
    const has = (type: string) => marks.some((mark) => mark.type === type);
    const link = marks.find((mark) => mark.type === 'link');

    const run = new TextRun({
      text: node.text,
      bold: has('bold') || undefined,
      italics: has('italic') || undefined,
      strike: has('strike') || undefined,
      ...(has('underline') ? { underline: {} } : {}),
      ...(has('code') ? { font: 'Consolas' } : {}),
    });

    if (link && typeof link.attrs?.href === 'string') {
      return [new ExternalHyperlink({ children: [run], link: link.attrs.href })];
    }
    return [run];
  });
}

/** Plain-text export, used for quick inspection and diff tooling. */
export function contentToText(content: DocumentContent): string {
  return flattenBlocks(content)
    .map((block) => block.text)
    .join('\n\n');
}
