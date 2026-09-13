import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const changedSinceKey = new PluginKey<DecorationSet>('changedSince');

/** Message sent to the plugin to change which blocks are marked. */
export interface ChangedSinceUpdate {
  /** Blocks changed since the chosen review boundary. */
  blockIds: string[];
}

/**
 * Track-change visualisation.
 *
 * Marks the paragraphs that have changed since a chosen checkpoint, using the
 * Change Ledger rather than anything derived from the text. The ledger already
 * knows precisely which blocks moved and when; recomputing that from a diff of
 * two snapshots would be slower and would disagree with the record in the
 * cases that matter, like a paragraph edited and then edited back.
 *
 * Decorations only - the document is untouched, so this can be turned on and
 * off during editing without the aggregator noticing anything.
 */
export const ChangedSince = Extension.create({
  name: 'changedSince',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: changedSinceKey,

        state: {
          init: () => DecorationSet.empty,

          apply(transaction, current, _oldState, newState) {
            const update = transaction.getMeta(changedSinceKey) as ChangedSinceUpdate | undefined;

            if (update) {
              const marked = new Set(update.blockIds);
              if (marked.size === 0) return DecorationSet.empty;

              const decorations: Decoration[] = [];
              newState.doc.descendants((node, pos) => {
                const id = node.attrs?.id;
                if (typeof id === 'string' && marked.has(id)) {
                  decorations.push(
                    Decoration.node(pos, pos + node.nodeSize, { class: 'block-changed' }),
                  );
                }
              });

              return DecorationSet.create(newState.doc, decorations);
            }

            // Follow the document as it is edited, so the marks stay on the
            // right paragraphs while the author keeps typing.
            return current.map(transaction.mapping, transaction.doc);
          },
        },

        props: {
          decorations(state) {
            return changedSinceKey.getState(state);
          },
        },
      }),
    ];
  },
});
