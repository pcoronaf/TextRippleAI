import { describe, expect, it } from 'vitest';

import { buildOutline, chapterIndex, ensureNodeIds, flattenBlocks } from '@/core/document';
import { contentHash, sha256Hex } from '@/core/hash';
import type { DocumentContent } from '@/core/types';

const doc = (...content: DocumentContent['content']): DocumentContent => ({
  type: 'doc',
  content,
});

const paragraph = (text: string, id?: string) => ({
  type: 'paragraph',
  ...(id ? { attrs: { id } } : {}),
  content: [{ type: 'text', text }],
});

const heading = (text: string, level: number, id?: string) => ({
  type: 'heading',
  attrs: { level, ...(id ? { id } : {}) },
  content: [{ type: 'text', text }],
});

describe('sha256', () => {
  it('matches known digests', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('handles multi-byte text and long input across block boundaries', () => {
    expect(sha256Hex('café — naïve')).toHaveLength(64);
    expect(sha256Hex('x'.repeat(1000))).toBe(sha256Hex('x'.repeat(1000)));
    expect(sha256Hex('x'.repeat(1000))).not.toBe(sha256Hex('x'.repeat(1001)));
  });

  it('prefixes content hashes', () => {
    expect(contentHash('abc')).toBe(`sha256:${sha256Hex('abc')}`);
  });
});

describe('persistent node identity', () => {
  it('assigns an ID to every node that lacks one', () => {
    const { content, assigned } = ensureNodeIds(doc(paragraph('One'), paragraph('Two')));

    expect(assigned).toBe(2);
    const ids = content.content.map((node) => node.attrs?.id);
    expect(ids.every((id) => typeof id === 'string' && id.startsWith('p_'))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves existing IDs untouched', () => {
    const original = ensureNodeIds(doc(paragraph('One'), paragraph('Two'))).content;
    const again = ensureNodeIds(original);

    expect(again.assigned).toBe(0);
    expect(again.content.content.map((node) => node.attrs?.id)).toEqual(
      original.content.map((node) => node.attrs?.id),
    );
  });

  it('adding a paragraph does not renumber the existing ones', () => {
    const original = ensureNodeIds(doc(paragraph('One'), paragraph('Two'))).content;
    const before = original.content.map((node) => node.attrs?.id);

    const extended = ensureNodeIds(
      doc(original.content[0], paragraph('Inserted'), original.content[1]),
    );

    expect(extended.assigned).toBe(1);
    expect(extended.content.content[0].attrs?.id).toBe(before[0]);
    expect(extended.content.content[2].attrs?.id).toBe(before[1]);
  });

  it('re-keys a duplicated ID, keeping the first in reading order', () => {
    // This is what a paragraph split produces: attributes are copied, so both
    // halves arrive carrying the same ID.
    const split = ensureNodeIds(doc(paragraph('First half', 'p_keep'), paragraph('Second half', 'p_keep')));

    expect(split.assigned).toBe(1);
    expect(split.content.content[0].attrs?.id).toBe('p_keep');
    expect(split.content.content[1].attrs?.id).not.toBe('p_keep');
  });

  it('assigns IDs inside nested structures', () => {
    const { content } = ensureNodeIds(
      doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('Item')] }],
      }),
    );

    const list = content.content[0];
    const item = list.content?.[0];
    expect(typeof list.attrs?.id).toBe('string');
    expect(typeof item?.attrs?.id).toBe('string');
    expect(typeof item?.content?.[0].attrs?.id).toBe('string');
  });

  it('survives a JSON round trip', () => {
    const { content } = ensureNodeIds(doc(heading('Chapter', 1), paragraph('Body')));
    const restored = JSON.parse(JSON.stringify(content)) as DocumentContent;

    expect(ensureNodeIds(restored).assigned).toBe(0);
    expect(flattenBlocks(restored).map((block) => block.id)).toEqual(
      flattenBlocks(content).map((block) => block.id),
    );
  });
});

describe('document structure', () => {
  const structured = ensureNodeIds(
    doc(
      paragraph('Front matter'),
      heading('Chapter One', 1),
      paragraph('Alpha'),
      heading('Section', 2),
      paragraph('Beta'),
      heading('Chapter Two', 1),
      paragraph('Gamma'),
    ),
  ).content;

  it('flattens text blocks in reading order', () => {
    expect(flattenBlocks(structured).map((block) => block.text)).toEqual([
      'Front matter',
      'Chapter One',
      'Alpha',
      'Section',
      'Beta',
      'Chapter Two',
      'Gamma',
    ]);
  });

  it('builds an outline from headings', () => {
    expect(buildOutline(structured).map((item) => [item.title, item.level])).toEqual([
      ['Chapter One', 1],
      ['Section', 2],
      ['Chapter Two', 1],
    ]);
  });

  it('attributes each block to the chapter it sits under', () => {
    const blocks = flattenBlocks(structured);
    const chapters = chapterIndex(structured);

    const chapterOf = (text: string) =>
      chapters.get(blocks.find((block) => block.text === text)!.id)?.title ?? null;

    expect(chapterOf('Front matter')).toBeNull();
    expect(chapterOf('Alpha')).toBe('Chapter One');
    expect(chapterOf('Beta')).toBe('Chapter One');
    expect(chapterOf('Gamma')).toBe('Chapter Two');
  });
});
