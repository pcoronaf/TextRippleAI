/**
 * DOCX import and export - the M0 baseline.
 *
 * Supported both ways: headings, paragraphs, bold/italic/underline/strike,
 * inline code, hyperlinks, bulleted and numbered lists, tables, block quotes,
 * code blocks and horizontal rules.
 *
 * M8 adds footnotes and images. A footnote round-trips as a real Word footnote
 * and is tracked as a block of its own; an embedded image is written into the
 * .docx as a real picture, and one whose bytes we cannot read - a linked image,
 * or a format we do not measure - falls back to its alt text.
 *
 * Still out of scope: tracked changes and layout fidelity. Full Word fidelity
 * must not block the change-intelligence workflow, and the canonical
 * representation stays the internal JSON either way.
 */

import { htmlToContent } from './html';
import { decodeImage } from './image-data';
import { flattenBlocks, nodeText } from '@/core/document';
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

/**
 * Word has no horizontal-rule element.
 *
 * What Word's UI calls a horizontal rule is a VML rectangle carrying
 * `o:hr="t"`, and mammoth - which understands the drawing model, not VML -
 * drops it, along with the paragraph holding it. The rule leaves no trace in
 * the HTML at all, so a manuscript that uses rules as scene breaks loses every
 * one of them silently. A 3500-block book was found to lose 166 that way.
 *
 * The paragraph is therefore rewritten to a sentinel before conversion and
 * turned back into a horizontalRule afterwards. The sentinel is built from a
 * private-use codepoint, which cannot occur in real prose.
 */
const HR_SENTINEL = '\uE000textripple-horizontal-rule\uE000';

/** As it comes back, tolerating a converter that strips the private-use marks. */
const HR_TEXT = /^\uE000?textripple-horizontal-rule\uE000?$/;

/** A whole paragraph whose content includes a VML horizontal rule. */
const HR_PARAGRAPH = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?o:hr="t"[\s\S]*?<\/w:p>/g;

async function markHorizontalRules(buffer: Buffer): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file('word/document.xml');
  if (!part) return buffer;

  const xml = await part.async('string');
  // Nothing to do for the overwhelming majority of documents, and re-zipping
  // one needlessly would be a cost paid on every import.
  if (!xml.includes('o:hr="t"')) return buffer;

  zip.file(
    'word/document.xml',
    xml.replace(HR_PARAGRAPH, `<w:p><w:r><w:t>${HR_SENTINEL}</w:t></w:r></w:p>`),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Turn the sentinel paragraphs back into rules, at any depth. */
function restoreHorizontalRules(content: DocumentContent): DocumentContent {
  const convert = (node: ContentNode): ContentNode => {
    if (node.type === 'paragraph' && HR_TEXT.test(nodeText(node).trim())) {
      return { type: 'horizontalRule' };
    }
    return node.content ? { ...node, content: node.content.map(convert) } : node;
  };

  return { ...content, content: content.content.map(convert) };
}

/** DOCX -> canonical document JSON. */
export async function importDocx(buffer: Buffer): Promise<DocumentContent> {
  const prepared = await markHorizontalRules(buffer);
  const mammoth = await import('mammoth');
  const convert = (mammoth as any).convertToHtml ?? (mammoth as any).default?.convertToHtml;
  const result = await convert({ buffer: prepared });
  return restoreHorizontalRules(htmlToContent(result.value));
}

/** Collect every footnote in reading order, numbered from one. */
function collectFootnotes(content: DocumentContent): string[] {
  const notes: string[] = [];

  const visit = (node: ContentNode): void => {
    if (node.type === 'footnote') {
      notes.push((node.content ?? []).map((child) => child.text ?? '').join(''));
      return;
    }
    node.content?.forEach(visit);
  };

  content.content.forEach(visit);
  return notes;
}

/** Canonical document JSON -> DOCX. */
export async function exportDocx(content: DocumentContent, title: string): Promise<Buffer> {
  const docx = await import('docx');
  const { Document, Packer } = docx;

  // Word numbers footnotes itself; the order they appear in the document is the
  // order it expects them declared.
  const notes = collectFootnotes(content);
  const counter = { next: 1 };

  const children = content.content.flatMap((node) =>
    renderBlock(node, docx, { listLevel: 0, footnotes: counter }),
  );

  const document = new Document({
    title,
    ...(notes.length > 0
      ? {
          footnotes: Object.fromEntries(
            notes.map((text, index) => [
              index + 1,
              { children: [new docx.Paragraph(text)] },
            ]),
          ),
        }
      : {}),
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
  /** Running footnote number, shared across the whole render. */
  footnotes?: { next: number };
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
          children: renderInline(node.content ?? [], docx, context),
        }),
      ];
    }

    case 'paragraph':
      return [
        new Paragraph({
          children: renderInline(node.content ?? [], docx, context),
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
      return (node.content ?? []).flatMap((item) => renderBlock(item, docx, { ...nested, footnotes: context.footnotes }));
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
                    renderBlock(child, docx, { listLevel: 0, footnotes: context.footnotes }),
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

function renderInline(
  nodes: ContentNode[],
  docx: DocxModule,
  context: RenderContext = { listLevel: 0 },
): any[] {
  const { TextRun, ExternalHyperlink, FootnoteReferenceRun, ImageRun } = docx;

  // A run may be wrapped in a hyperlink or be a footnote marker, so the element
  // type is not uniform.
  return nodes.flatMap((node): any[] => {
    if (node.type === 'hardBreak') return [new TextRun({ text: '', break: 1 })];

    if (node.type === 'footnote') {
      // Word renders the marker and the number; the note's text was declared
      // on the document in the same reading order.
      const number = context.footnotes ? context.footnotes.next++ : 1;
      return [new FootnoteReferenceRun(number)];
    }

    if (node.type === 'image') {
      const decoded = decodeImage(node.attrs?.src);
      if (decoded) {
        return [
          new ImageRun({
            type: decoded.format,
            data: decoded.data,
            transformation: { width: decoded.width, height: decoded.height },
            ...(typeof node.attrs?.alt === 'string' && node.attrs.alt
              ? { altText: { name: node.attrs.alt, title: node.attrs.alt, description: node.attrs.alt } }
              : {}),
          }),
        ];
      }

      // A linked image, or a format whose header we cannot read, keeps its alt
      // text so the prose still reads rather than losing the reference.
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return alt ? [new TextRun({ text: alt, italics: true })] : [];
    }

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
