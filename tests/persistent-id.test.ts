// @vitest-environment jsdom
/**
 * The persistent-ID plugin exercised through a real Tiptap editor.
 *
 * `ensureNodeIds` covers the same rules for content arriving over the wire;
 * these tests cover the editing path, where IDs are assigned by a ProseMirror
 * transaction rather than by the server.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { PersistentId } from '@/editor/extensions/persistent-id';
import type { DocumentContent } from '@/core/types';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content: unknown): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, PersistentId],
    content,
  });
  return editor;
}

const paragraph = (text: string, id?: string) => ({
  type: 'paragraph',
  ...(id ? { attrs: { id } } : {}),
  content: [{ type: 'text', text }],
});

const idsOf = (instance: Editor): (string | undefined)[] =>
  (instance.getJSON() as DocumentContent).content.map(
    (node) => node.attrs?.id as string | undefined,
  );

describe('PersistentId extension', () => {
  it('assigns an ID to every block on the first edit', () => {
    const instance = makeEditor({
      type: 'doc',
      content: [paragraph('One'), paragraph('Two')],
    });

    instance.commands.insertContentAt(2, 'X');
    const ids = idsOf(instance);

    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not change IDs while typing', () => {
    const instance = makeEditor({
      type: 'doc',
      content: [paragraph('One', 'p_alpha'), paragraph('Two', 'p_beta')],
    });

    instance.commands.insertContentAt(2, 'X');
    expect(idsOf(instance)).toEqual(['p_alpha', 'p_beta']);

    instance.commands.insertContentAt(3, 'Y');
    instance.commands.insertContentAt(4, 'Z');
    expect(idsOf(instance)).toEqual(['p_alpha', 'p_beta']);
  });

  it('does not renumber existing blocks when one is added', () => {
    const instance = makeEditor({
      type: 'doc',
      content: [paragraph('One', 'p_alpha'), paragraph('Two', 'p_beta')],
    });

    instance.commands.setTextSelection(instance.state.doc.content.size - 1);
    instance.commands.insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'New' }] });

    const ids = idsOf(instance);
    expect(ids[0]).toBe('p_alpha');
    expect(ids).toContain('p_beta');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the first half of a split and re-keys the remainder', () => {
    const instance = makeEditor({
      type: 'doc',
      content: [paragraph('Hello world', 'p_alpha')],
    });

    // Cursor between "Hello" and " world".
    instance.commands.setTextSelection(6);
    instance.commands.splitBlock();

    const json = instance.getJSON() as DocumentContent;
    expect(json.content).toHaveLength(2);
    expect(json.content[0].attrs?.id).toBe('p_alpha');
    expect(json.content[1].attrs?.id).not.toBe('p_alpha');
    expect(typeof json.content[1].attrs?.id).toBe('string');
  });

  it('re-keys a duplicated ID, such as one arriving by paste', () => {
    const instance = makeEditor({ type: 'doc', content: [paragraph('One', 'p_alpha')] });

    instance.commands.setContent({
      type: 'doc',
      content: [paragraph('One', 'p_alpha'), paragraph('Pasted copy', 'p_alpha')],
    });

    const ids = idsOf(instance);
    expect(ids[0]).toBe('p_alpha');
    expect(ids[1]).not.toBe('p_alpha');
  });

  it('serialises the identifier as data-id so it survives a round trip', () => {
    const instance = makeEditor({ type: 'doc', content: [paragraph('One', 'p_alpha')] });
    instance.commands.insertContentAt(2, 'X');

    expect(instance.getHTML()).toContain('data-id="p_alpha"');
  });

  it('assigns IDs inside lists', () => {
    const instance = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph('Item')] }],
        },
      ],
    });

    instance.commands.insertContentAt(4, 'X');

    const list = (instance.getJSON() as DocumentContent).content[0];
    const item = list.content?.[0];
    expect(typeof list.attrs?.id).toBe('string');
    expect(typeof item?.attrs?.id).toBe('string');
    expect(typeof item?.content?.[0].attrs?.id).toBe('string');
  });
});
