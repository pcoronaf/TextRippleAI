import { describe, expect, it } from 'vitest';

import { ensureNodeIds, flattenBlocks, nodeText, ownText } from '@/core/document';
import { htmlToContent } from '@/formats/html';
import { contentToMarkdown } from '@/formats/markdown';
import type { ContentNode, DocumentContent } from '@/core/types';

const footnote = (text: string): ContentNode => ({
  type: 'footnote',
  content: [{ type: 'text', text }],
});

const withFootnote = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Oversight is required.' },
          footnote('See ISO/IEC 42001, clause 9.'),
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'A plain paragraph.' }] },
    ],
  }).content;

describe('footnotes in the change model', () => {
  it('keeps footnote text out of the paragraph that carries it', () => {
    const content = withFootnote();
    const paragraph = content.content[0];

    // Folding the note into the prose would corrupt every diff, embedding and
    // summary this paragraph takes part in.
    expect(nodeText(paragraph)).toBe('Oversight is required.');
    expect(ownText(paragraph)).toContain('ISO/IEC 42001');
  });

  it('flattens a footnote as a block of its own', () => {
    const blocks = flattenBlocks(withFootnote());

    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'footnote', 'paragraph']);
    expect(blocks[1].text).toBe('See ISO/IEC 42001, clause 9.');
  });

  it('gives a footnote a persistent identity', () => {
    const content = withFootnote();
    const before = flattenBlocks(content).map((block) => block.id);

    // Re-running identity assignment must not renumber anything.
    expect(ensureNodeIds(content).assigned).toBe(0);
    expect(flattenBlocks(content).map((block) => block.id)).toEqual(before);
    expect(before[1]).toMatch(/^n_|^p_|^h_|^[a-z]+_/);
  });

  it('so editing a note is a tracked change', async () => {
    const { ChangeAggregator } = await import('@/core/change-aggregator');
    const content = withFootnote();
    const blocks = flattenBlocks(content);

    const aggregator = new ChangeAggregator(blocks, { sessionId: 'sess_test', idleMs: 100 });
    aggregator.observe(
      blocks.map((block) =>
        block.type === 'footnote' ? { ...block, text: 'See ISO/IEC 42001, clause 10.' } : block,
      ),
      0,
    );

    const [change] = aggregator.drain(200);
    expect(change.blockId).toBe(blocks[1].id);
    expect(change.after).toContain('clause 10');
  });
});

describe('footnotes and images through HTML', () => {
  it('folds Word footnote definitions into their references', () => {
    // What mammoth produces: superscript links into a list at the end.
    const content = htmlToContent(
      '<p>Oversight is required.<sup><a href="#footnote-1">1</a></sup></p>' +
        '<ol><li id="footnote-1">See ISO/IEC 42001. <a href="#ref-1">↑</a></li></ol>',
    );

    const blocks = flattenBlocks(content);
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'footnote']);
    expect(blocks[0].text).toBe('Oversight is required.');
    expect(blocks[1].text).toContain('See ISO/IEC 42001.');
  });

  it('does not also emit the footnote list as ordinary content', () => {
    const content = htmlToContent(
      '<p>Text<sup><a href="#footnote-1">1</a></sup></p><ol><li id="footnote-1">The note.</li></ol>',
    );

    expect(content.content.some((node) => node.type === 'orderedList')).toBe(false);
  });

  it('keeps an ordinary list that is not footnotes', () => {
    const content = htmlToContent('<ol><li>First</li><li>Second</li></ol>');
    expect(content.content[0].type).toBe('orderedList');
  });

  it('keeps images as images rather than stripping them to alt text', () => {
    const content = htmlToContent(
      '<p>Before <img src="data:image/png;base64,AAA" alt="A diagram" title="Figure 1"> after</p>',
    );

    const image = content.content[0].content?.find((node) => node.type === 'image');
    expect(image?.attrs?.src).toBe('data:image/png;base64,AAA');
    expect(image?.attrs?.alt).toBe('A diagram');
    expect(image?.attrs?.title).toBe('Figure 1');
  });

  it('drops an image with no source rather than emitting an empty node', () => {
    const content = htmlToContent('<p><img alt="orphan"></p>');
    expect(content.content[0].content?.some((node) => node.type === 'image')).toBe(false);
  });
});

describe('markdown export', () => {
  it('writes footnotes inline and images as links', () => {
    const content = ensureNodeIds({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Claim.' },
            footnote('The source.'),
            { type: 'image', attrs: { src: 'https://example.org/a.png', alt: 'A chart' } },
          ],
        },
      ],
    }).content;

    const markdown = contentToMarkdown(content);
    expect(markdown).toContain('^[The source.]');
    expect(markdown).toContain('![A chart](https://example.org/a.png)');
  });
});
