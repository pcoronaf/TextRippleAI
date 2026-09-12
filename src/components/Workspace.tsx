'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { buildOutline } from '@/core/document';
import { useDocumentSession } from '@/editor/use-document-session';
import type {
  ChangeRecord,
  ChangesSinceSummary,
  CheckpointRecord,
  DocumentContent,
  DocumentRecord,
} from '@/core/types';

import { EditorPane } from './EditorPane';
import { ReviewSidebar } from './ReviewSidebar';

export function Workspace({
  document: record,
  initialContent,
}: {
  document: DocumentRecord;
  initialContent: DocumentContent;
}) {
  const [content, setContent] = useState<DocumentContent>(initialContent);
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [summary, setSummary] = useState<ChangesSinceSummary | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [hideTrivial, setHideTrivial] = useState(false);

  const refresh = useCallback(async () => {
    const query = new URLSearchParams();
    if (scope) query.set('since', scope);
    if (hideTrivial) query.set('includeTrivial', 'false');

    const [ledger, boundaries] = await Promise.all([
      fetch(`/api/documents/${record.id}/changes?${query}`).then((response) => response.json()),
      fetch(`/api/documents/${record.id}/checkpoints`).then((response) => response.json()),
    ]);

    setChanges(ledger.changes ?? []);
    setSummary(ledger.summary ?? null);
    setCheckpoints(boundaries.checkpoints ?? []);
  }, [hideTrivial, record.id, scope]);

  const { state, handleUpdate, flushAndSave, createCheckpoint } = useDocumentSession({
    documentId: record.id,
    initialContent,
    initialRevision: record.currentRevision,
    onSaved: () => void refresh(),
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onEditorChange = useCallback(
    (next: DocumentContent) => {
      setContent(next);
      handleUpdate(next);
    },
    [handleUpdate],
  );

  const outline = useMemo(() => buildOutline(content), [content]);

  const scrollToBlock = useCallback((blockId: string) => {
    const target = window.document.querySelector<HTMLElement>(`[data-id="${blockId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('block-highlight');
    setTimeout(() => target.classList.remove('block-highlight'), 1600);
  }, []);

  return (
    <div className="workspace">
      <header className="toolbar">
        <span className="brand">
          TextRippleAI<span>{record.title}</span>
        </span>
        <div className="spacer" />
        <button onClick={() => void flushAndSave()} disabled={state.saving}>
          {state.saving ? 'Saving...' : 'Save now'}
        </button>
        <a href={`/api/documents/${record.id}/export?format=docx`}>
          <button>Export DOCX</button>
        </a>
        <a href={`/api/documents/${record.id}/export?format=md`}>
          <button>Markdown</button>
        </a>
        <a href="/">
          <button>All documents</button>
        </a>
      </header>

      <div className="panes">
        <nav className="pane">
          <div className="pane-heading">Outline</div>
          {outline.length === 0 ? (
            <p className="panel-note" style={{ margin: '0 14px' }}>
              Headings appear here as you write them.
            </p>
          ) : (
            outline.map((item) => (
              <button
                key={item.id}
                className="outline-item"
                data-level={item.level}
                onClick={() => scrollToBlock(item.id)}
              >
                {item.title}
              </button>
            ))
          )}
        </nav>

        <main className="pane">
          <EditorPane
            initialContent={initialContent}
            onChange={onEditorChange}
            onBlur={() => void flushAndSave()}
          />
        </main>

        <aside className="pane">
          <ReviewSidebar
            changes={changes}
            summary={summary}
            checkpoints={checkpoints}
            scope={scope}
            onScopeChange={setScope}
            hideTrivial={hideTrivial}
            onHideTrivialChange={setHideTrivial}
            onCreateCheckpoint={async (name) => {
              await createCheckpoint(name);
              await refresh();
            }}
            onSelectBlock={scrollToBlock}
            busy={state.saving}
          />
        </aside>
      </div>

      <footer className="statusbar">
        <span>
          {state.pendingCount} pending change{state.pendingCount === 1 ? '' : 's'}
        </span>
        <span>revision {state.revision}</span>
        <span>
          {checkpoints.length > 0
            ? `Last checkpoint: ${checkpoints[0].name}`
            : 'No checkpoint yet'}
        </span>
        <span>
          {state.saving
            ? 'Saving...'
            : state.lastSavedAt
              ? `Saved ${new Date(state.lastSavedAt).toLocaleTimeString()}`
              : 'Not saved yet'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <span>0 LLM calls this session</span>
        {state.error && <span className="error">{state.error}</span>}
      </footer>
    </div>
  );
}
