import { describe, expect, it } from 'vitest';

import { ApplyTargetNotFoundError, replaceBlockText, spliceInlineText } from '@/core/apply';
import { ensureNodeIds, flattenBlocks, nodeText } from '@/core/document';
import type { ContentNode, DocumentContent } from '@/core/types';

const text = (value: string, marks?: string[]): ContentNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
});

const marksOf = (nodes: ContentNode[]) =>
  nodes.map((node) => [node.text, (node.marks ?? []).map((mark) => mark.type).join('+')]);

describe('spliceInlineText', () => {
  it('returns the original content when nothing changed', () => {
    const inline = [text('Hello '), text('world', ['bold'])];
    expect(spliceInlineText(inline, 'Hello world', 'Hello world')).toEqual(inline);
  });

  it('replaces plain text wholesale', () => {
    const result = spliceInlineText([text('Old sentence.')], 'Old sentence.', 'New sentence.');
    expect(result).toEqual([text('New sentence.')]);
  });

  it('keeps formatting on the unchanged prefix and suffix', () => {
    // "The system is bold and linked."  ->  edit only the middle words.
    const inline = [text('The '), text('system', ['bold']), text(' is safe.')];
    const before = 'The system is safe.';
    const after = 'The system is safe enough.';

    const result = spliceInlineText(inline, before, after);

    expect(result.map((node) => node.text).join('')).toBe(after);
    expect(marksOf(result)).toContainEqual(['system', 'bold']);
  });

  it('keeps a trailing link when the opening clause is rewritten', () => {
    const inline = [text('Zero Trust assumes nothing, see '), text('ISO 27001', ['link'])];
    const before = 'Zero Trust assumes nothing, see ISO 27001';
    const after = 'Zero Trust avoids implicit trust, see ISO 27001';

    const result = spliceInlineText(inline, before, after);

    expect(result.map((node) => node.text).join('')).toBe(after);
    expect(marksOf(result)).toContainEqual(['ISO 27001', 'link']);
  });

  it('drops to plain text when the whole passage is rewritten', () => {
    const inline = [text('Alpha ', ['bold']), text('beta', ['italic'])];
    const result = spliceInlineText(inline, 'Alpha beta', 'Entirely different wording.');

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Entirely different wording.');
  });

  it('returns empty content for an empty replacement', () => {
    expect(spliceInlineText([text('Something')], 'Something', '')).toEqual([]);
  });
});

describe('replaceBlockText', () => {
  const document = (): DocumentContent =>
    ensureNodeIds({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Chapter One')] },
        { type: 'paragraph', content: [text('The '), text('original', ['bold']), text(' text.')] },
        { type: 'paragraph', content: [text('Another paragraph.')] },
      ],
    }).content;

  it('replaces only the targeted block', () => {
    const content = document();
    const blocks = flattenBlocks(content);
    const next = replaceBlockText(content, blocks[1].id, 'The original text, revised.');

    const after = flattenBlocks(next);
    expect(after[0].text).toBe('Chapter One');
    expect(after[1].text).toBe('The original text, revised.');
    expect(after[2].text).toBe('Another paragraph.');
  });

  it('keeps the block identity and its attributes', () => {
    const content = document();
    const blocks = flattenBlocks(content);
    const next = replaceBlockText(content, blocks[1].id, 'Completely new wording.');

    // A rewritten paragraph is the same paragraph - that is what makes the
    // change traceable afterwards.
    expect(flattenBlocks(next).map((block) => block.id)).toEqual(blocks.map((block) => block.id));
  });

  it('preserves heading level when a heading is rewritten', () => {
    const content = document();
    const blocks = flattenBlocks(content);
    const next = replaceBlockText(content, blocks[0].id, 'Chapter One, Revised');

    expect(next.content[0].attrs?.level).toBe(1);
    expect(nodeText(next.content[0])).toBe('Chapter One, Revised');
  });

  it('does not mutate the input', () => {
    const content = document();
    const snapshot = JSON.stringify(content);
    replaceBlockText(content, flattenBlocks(content)[1].id, 'Changed.');

    expect(JSON.stringify(content)).toBe(snapshot);
  });

  it('rejects a block that is not in the document', () => {
    expect(() => replaceBlockText(document(), 'p_missing', 'text')).toThrow(
      ApplyTargetNotFoundError,
    );
  });

  it('handles a block emptied to nothing', () => {
    const content = document();
    const blocks = flattenBlocks(content);
    const next = replaceBlockText(content, blocks[2].id, '');

    expect(flattenBlocks(next)[2].text).toBe('');
  });
});
