import { describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentToText } from '@/formats/docx';
import { htmlToContent } from '@/formats/html';
import { contentToMarkdown, markdownToContent, textToContent } from '@/formats/markdown';

describe('htmlToContent', () => {
  it('maps headings, paragraphs and inline marks', () => {
    const content = htmlToContent(
      '<h1>Chapter One</h1><p>A <strong>bold</strong> and <em>italic</em> claim.</p>',
    );

    expect(content.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    const marks = content.content[1].content?.flatMap((node) => node.marks?.map((m) => m.type) ?? []);
    expect(marks).toContain('bold');
    expect(marks).toContain('italic');
  });

  it('assigns persistent IDs to everything it produces', () => {
    const content = htmlToContent('<h1>Title</h1><p>Body</p>');
    const ids = flattenBlocks(content).map((block) => block.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ensureNodeIds(content).assigned).toBe(0);
  });

  it('maps lists, tables, quotes and rules', () => {
    const content = htmlToContent(
      '<ul><li>One</li><li>Two</li></ul>' +
        '<ol><li>First</li></ol>' +
        '<blockquote><p>Quoted</p></blockquote>' +
        '<hr>' +
        '<table><tr><th>H</th></tr><tr><td>C</td></tr></table>',
    );

    expect(content.content.map((node) => node.type)).toEqual([
      'bulletList',
      'orderedList',
      'blockquote',
      'horizontalRule',
      'table',
    ]);

    const table = content.content[4];
    expect(table.content?.[0].content?.[0].type).toBe('tableHeader');
    expect(table.content?.[1].content?.[0].type).toBe('tableCell');
  });

  it('keeps hyperlinks as link marks', () => {
    const content = htmlToContent('<p><a href="https://example.org">Example</a></p>');
    const link = content.content[0].content?.[0].marks?.find((mark) => mark.type === 'link');

    expect(link?.attrs?.href).toBe('https://example.org');
  });

  it('decodes entities and keeps unknown elements as prose', () => {
    const content = htmlToContent('<p>Caf&eacute; &amp; more</p><figure>Kept text</figure>');

    expect(contentToText(content)).toContain('&');
    expect(contentToText(content)).toContain('Kept text');
  });

  it('never produces an empty document', () => {
    expect(flattenBlocks(htmlToContent('')).length).toBeGreaterThan(0);
  });
});

describe('markdown', () => {
  it('imports headings, lists and emphasis', async () => {
    const content = await markdownToContent(
      '# Title\n\nSome **bold** text.\n\n- one\n- two\n\n1. first\n',
    );

    expect(content.content.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
    ]);
  });

  it('round-trips structure through markdown', async () => {
    const source = '# Chapter One\n\nAn opening claim.\n\n## Section\n\nA supporting claim.';
    const content = await markdownToContent(source);
    const rendered = contentToMarkdown(content);

    expect(rendered).toContain('# Chapter One');
    expect(rendered).toContain('## Section');
    expect(rendered).toContain('An opening claim.');

    const reimported = await markdownToContent(rendered);
    expect(flattenBlocks(reimported).map((block) => block.text)).toEqual(
      flattenBlocks(content).map((block) => block.text),
    );
  });

  it('exports inline marks and links', () => {
    const content = htmlToContent(
      '<p><strong>Bold</strong> and <a href="https://example.org">link</a>.</p>',
    );

    const markdown = contentToMarkdown(content);
    expect(markdown).toContain('**Bold**');
    expect(markdown).toContain('[link](https://example.org)');
  });
});

describe('plain text', () => {
  it('splits on blank lines and keeps every paragraph', () => {
    const content = textToContent('First paragraph.\n\nSecond paragraph.\n\n\nThird.');
    const blocks = flattenBlocks(content);

    expect(blocks.map((block) => block.text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third.',
    ]);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(3);
  });

  it('produces a usable document from empty input', () => {
    expect(textToContent('').content).toHaveLength(1);
  });
});
