'use client';

import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import { BubbleMenu, EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';

import { TEXT_BLOCK_TYPES } from '@/core/document';
import { ChangedSince, changedSinceKey } from '@/editor/extensions/changed-since';
import { Footnote } from '@/editor/extensions/footnote';
import { PersistentId } from '@/editor/extensions/persistent-id';
import type { DocumentContent } from '@/core/types';

/** What the author currently has selected, resolved to a document node. */
export interface EditorSelection {
  blockId: string | null;
  text: string;
  from: number;
  to: number;
}

export interface EditorPaneProps {
  initialContent: DocumentContent;
  onChange: (content: DocumentContent) => void;
  onBlur?: () => void;
  onSelectionChange?: (selection: EditorSelection) => void;
  /** Raised by the floating toolbar. The selection is already reported. */
  onAskAction?: (action: 'ask' | 'explain' | 'modify') => void;
  /** Blocks changed since the chosen review boundary, marked in the margin. */
  changedBlockIds?: string[];
  /** Handed the editor once it exists, so an accepted proposal can be applied. */
  onEditorReady?: (editor: Editor) => void;
}

/**
 * Resolve the selection to the block that contains it.
 *
 * Identity comes from the node, never from the character offsets - the offsets
 * are reported alongside only so the conversation can record where in the
 * paragraph the author was looking.
 */
function readSelection(editor: Editor): EditorSelection {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  const resolved = state.doc.resolve(from);

  let blockId: string | null = null;
  for (let depth = resolved.depth; depth > 0; depth--) {
    const node = resolved.node(depth);
    if (TEXT_BLOCK_TYPES.has(node.type.name) && typeof node.attrs?.id === 'string') {
      blockId = node.attrs.id;
      break;
    }
  }

  return {
    blockId,
    text: empty ? '' : state.doc.textBetween(from, to, ' '),
    from,
    to,
  };
}

export function EditorPane({
  initialContent,
  onChange,
  onBlur,
  onSelectionChange,
  onAskAction,
  changedBlockIds,
  onEditorReady,
}: EditorPaneProps) {
  const editor = useEditor({
    // Tiptap must not render during SSR; the document is hydrated client-side.
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: true, allowBase64: true }),
      Footnote,
      ChangedSince,
      PersistentId,
    ],
    content: initialContent,
    editorProps: {
      attributes: { class: 'document-body', spellcheck: 'true' },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getJSON() as DocumentContent);
    },
    onSelectionUpdate: ({ editor: instance }) => {
      onSelectionChange?.(readSelection(instance));
    },
    onBlur: () => onBlur?.(),
  });

  useEffect(() => {
    if (editor) onEditorReady?.(editor);
  }, [editor, onEditorReady]);

  // Decorations only: turning the marks on and off never touches the document,
  // so the Change Aggregator sees nothing.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(changedSinceKey, { blockIds: changedBlockIds ?? [] }),
    );
  }, [changedBlockIds, editor]);

  return (
    <div className="editor-scroll">
      {editor && (
        <BubbleMenu
          editor={editor}
          tippyOptions={{ duration: 120, placement: 'top' }}
          shouldShow={({ state }) => !state.selection.empty}
        >
          <div className="bubble-menu">
            <button onClick={() => onAskAction?.('ask')}>Ask AI</button>
            <button onClick={() => onAskAction?.('explain')}>Explain</button>
            <button onClick={() => onAskAction?.('modify')}>Modify</button>
            <button disabled title="Consistency analysis arrives in M5">
              Check consistency
            </button>
          </div>
        </BubbleMenu>
      )}

      <div className="editor-sheet">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
