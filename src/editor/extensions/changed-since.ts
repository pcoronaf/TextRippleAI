import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import type { TextRange } from '@/core/diff';

export const changedSinceKey = new PluginKey<DecorationSet>('changedSince');

export interface ChangedBlock {
  id: string;
  /**
   * Character ranges within the block's text that are new since the review
   * boundary. Empty means "changed, but we cannot say where" - the whole block
   * is marked instead.
   */
  ranges?: TextRange[];
}

/** Message sent to the plugin to change which blocks are marked. */
export interface ChangedSinceUpdate {
  blocks: ChangedBlock[];
}

/**
 * Map character offsets in a block's text onto positions in the document.
 *
 * The two do not line up: a footnote or an image is a child of the paragraph
 * and occupies a position, but contributes nothing to the text the change
 * model records. Walking the children and advancing the text offset only for
 * text nodes reproduces exactly what `nodeText` produced, so a paragraph
 * carrying a note still marks the right words.
 */
function textSpans(block: ProseMirrorNode, blockPos: number): {
  from: number;
  textFrom: number;
  length: number;
}[] {
  const spans: { from: number; textFrom: number; length: number }[] = [];
  let textOffset = 0;

  const visit = (node: ProseMirrorNode, pos: number): void => {
    node.forEach((child, offset) => {
      const childPos = pos + 1 + offset;

      if (child.isText) {
        const length = child.text?.length ?? 0;
        spans.push({ from: childPos, textFrom: textOffset, length });
        textOffset += length;
      } else if (child.type.name !== 'footnote' && child.content.size > 0) {
        visit(child, childPos);
      }
      // Footnotes, images and hard breaks contribute no text, exactly as the
      // change model sees them.
    });
  };

  visit(block, blockPos);
  return spans;
}

function decorationsFor(block: ProseMirrorNode, pos: number, ranges: TextRange[]): Decoration[] {
  const spans = textSpans(block, pos);
  const decorations: Decoration[] = [];

  for (const range of ranges) {
    for (const span of spans) {
      const from = Math.max(range.from, span.textFrom);
      const to = Math.min(range.to, span.textFrom + span.length);
      if (to <= from) continue;

      decorations.push(
        Decoration.inline(
          span.from + (from - span.textFrom),
          span.from + (to - span.textFrom),
          { class: 'text-changed' },
        ),
      );
    }
  }

  return decorations;
}

/**
 * Track-change visualisation.
 *
 * Marks what has changed since a chosen checkpoint, using the Change Ledger
 * rather than anything derived from the current text. The ledger already knows
 * precisely which blocks moved and when; recomputing that from a diff of two
 * snapshots would be slower and would disagree with the record in the cases
 * that matter, like a paragraph edited and then edited back.
 *
 * Within a block, the ledger's stored before-text gives the words that are new,
 * so the marks are on the phrases that moved rather than on the whole
 * paragraph. Deletions are not shown: the text is not in the document, and
 * displaying it would mean rendering words the document does not contain.
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
              const marked = new Map(update.blocks.map((block) => [block.id, block.ranges ?? []]));
              if (marked.size === 0) return DecorationSet.empty;

              const decorations: Decoration[] = [];
              newState.doc.descendants((node, pos) => {
                const id = node.attrs?.id;
                if (typeof id !== 'string' || !marked.has(id)) return;

                const ranges = marked.get(id) ?? [];
                const inline = ranges.length > 0 ? decorationsFor(node, pos, ranges) : [];

                // Marking the block as a whole is the honest answer when the
                // ledger cannot say which words moved - a block that was added
                // outright, or one whose before-text was not recorded.
                if (inline.length > 0) decorations.push(...inline);
                else decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'block-changed' }));
              });

              return DecorationSet.create(newState.doc, decorations);
            }

            // Follow the document as it is edited, so the marks stay on the
            // right words while the author keeps typing.
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
