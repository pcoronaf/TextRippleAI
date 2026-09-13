import { Node, mergeAttributes } from '@tiptap/core';

/**
 * A footnote, carried inline where it belongs.
 *
 * The note lives inside the paragraph that references it rather than in a list
 * at the end of the document. That matters for more than tidiness: the change
 * model tracks a footnote as a block of its own, with its own identity and its
 * own ledger entries, so editing a note is a recorded change and the note can
 * be an impact target - while the paragraph's prose stays clean, because
 * `nodeText` skips footnote subtrees.
 *
 * Rendered as a superscript marker; Word numbers them on export.
 */
export const Footnote = Node.create({
  name: 'footnote',

  group: 'inline',
  inline: true,
  // Text only: a footnote holding block content would be a second document.
  content: 'text*',
  atom: false,

  parseHTML() {
    return [{ tag: 'span[data-footnote]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-footnote': '', class: 'footnote' }),
      0,
    ];
  },

  addCommands() {
    return {
      insertFootnote:
        (text = '') =>
        ({ chain }: { chain: () => any }) =>
          chain()
            .focus()
            .insertContent({
              type: this.name,
              content: text ? [{ type: 'text', text }] : [{ type: 'text', text: 'Note' }],
            })
            .run(),
    } as never;
  },
});
