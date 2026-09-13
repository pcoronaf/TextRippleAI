import { describe, expect, it } from 'vitest';

import { importDocx } from '@/formats/docx';
import { retitleOnEdit, UNTITLED_DOCUMENT } from '@/core/document';
import type { DocumentContent } from '@/core/types';

/**
 * Build a minimal .docx around a body fragment.
 *
 * Word has no horizontal-rule element - the UI's rule is a VML rectangle - and
 * mammoth drops it silently, so this is checked against a real package rather
 * than against an HTML fixture that assumes what the converter produces.
 */
async function docxWith(body: string): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
      `<w:body>${body}</w:body></w:document>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
/** Exactly what Word writes for a horizontal rule. */
const rule =
  '<w:p><w:r><w:pict><v:rect id="_x0000_i1025" style="width:0;height:1.5pt"' +
  ' o:hralign="center" o:hrstd="t" o:hr="t"/></w:pict></w:r></w:p>';

const types = (content: DocumentContent) => content.content.map((node) => node.type);

describe('horizontal rules in a Word document', () => {
  it('keeps a rule that Word wrote as a VML rectangle', async () => {
    const content = await importDocx(await docxWith(paragraph('Before.') + rule + paragraph('After.')));

    expect(types(content)).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
  });

  it('keeps every rule in a document that uses them as scene breaks', async () => {
    const body = Array.from({ length: 12 }, (_, i) => paragraph(`Scene ${i}.`) + rule).join('');
    const content = await importDocx(await docxWith(body));

    expect(types(content).filter((type) => type === 'horizontalRule')).toHaveLength(12);
  });

  it('leaves the sentinel nowhere in the text', async () => {
    const content = await importDocx(await docxWith(paragraph('Before.') + rule));
    const text = JSON.stringify(content);

    expect(text).not.toContain('textripple-horizontal-rule');
    expect(text).not.toContain('\uE000');
  });

  it('does not disturb a document with no rules in it', async () => {
    const content = await importDocx(await docxWith(paragraph('One.') + paragraph('Two.')));

    expect(types(content)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('a document keeps the title it was given', () => {
  const content: DocumentContent = {
    type: 'doc',
    content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter 1' }] }],
  };

  it('does not rename a document on save', () => {
    // Importing Book_DRAFT.docx and then typing one character must not turn the
    // document into "Chapter 1".
    expect(retitleOnEdit('The-Other-Half-of-Doubt', content)).toBe('The-Other-Half-of-Doubt');
  });

  it('still names a document that has never had a title', () => {
    expect(retitleOnEdit(UNTITLED_DOCUMENT, content)).toBe('Chapter 1');
    expect(retitleOnEdit('', content)).toBe('Chapter 1');
    expect(retitleOnEdit(null, content)).toBe('Chapter 1');
  });

  it('leaves the placeholder alone when there is nothing to infer from', () => {
    expect(retitleOnEdit(UNTITLED_DOCUMENT, { type: 'doc', content: [] })).toBe(UNTITLED_DOCUMENT);
  });
});
