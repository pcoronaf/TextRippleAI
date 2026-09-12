import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { ID_NODE_TYPES } from '@/core/document';
import { newNodeId } from '@/core/ids';

/**
 * Gives every meaningful node a persistent identifier.
 *
 * The identifier is stored as a node attribute and serialised as `data-id`, so
 * it survives save/load and copy/paste round trips. On every document-changing
 * transaction the plugin walks the document and assigns an ID to any node that
 * lacks one or that shares one with an earlier node.
 *
 * Duplicates are routine rather than exceptional: splitting a paragraph copies
 * its attributes onto both halves, and pasting a block copies its ID. The node
 * appearing first in reading order keeps the ID, so splitting a paragraph
 * leaves the opening half with its original identity and gives the remainder a
 * new one. Nodes that were not touched are never renumbered.
 *
 * ID assignment is excluded from the undo stack: it is bookkeeping about the
 * user's edit, not an edit of its own.
 */
export const PersistentId = Extension.create({
  name: 'persistentId',

  addGlobalAttributes() {
    return [
      {
        types: [...ID_NODE_TYPES],
        attributes: {
          id: {
            default: null,
            // Keep the attribute through a split; the plugin below re-keys the
            // duplicate that the split produces.
            keepOnSplit: true,
            parseHTML: (element) => element.getAttribute('data-id'),
            renderHTML: (attributes) =>
              attributes.id ? { 'data-id': attributes.id as string } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('persistentId'),

        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;

          const tr = newState.tr;
          const seen = new Set<string>();
          let modified = false;

          newState.doc.descendants((node, pos) => {
            if (!ID_NODE_TYPES.has(node.type.name)) return;

            const id = node.attrs.id;
            if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
              seen.add(id);
              return;
            }

            const assigned = newNodeId(node.type.name);
            // setNodeMarkup does not change node sizes, so positions gathered
            // during this walk stay valid.
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: assigned });
            seen.add(assigned);
            modified = true;
          });

          return modified ? tr.setMeta('addToHistory', false) : null;
        },
      }),
    ];
  },
});
