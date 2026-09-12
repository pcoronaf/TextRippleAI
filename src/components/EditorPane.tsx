'use client';

import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { PersistentId } from '@/editor/extensions/persistent-id';
import type { DocumentContent } from '@/core/types';

export interface EditorPaneProps {
  initialContent: DocumentContent;
  onChange: (content: DocumentContent) => void;
  onBlur?: () => void;
}

export function EditorPane({ initialContent, onChange, onBlur }: EditorPaneProps) {
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
      PersistentId,
    ],
    content: initialContent,
    editorProps: {
      attributes: { class: 'document-body', spellcheck: 'true' },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getJSON() as DocumentContent);
    },
    onBlur: () => onBlur?.(),
  });

  return (
    <div className="editor-scroll">
      <div className="editor-sheet">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
