'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import type { DocumentRecord } from '@/core/types';

export function DocumentList({
  documents,
  storeKind,
}: {
  documents: DocumentRecord[];
  storeKind: 'postgres' | 'file';
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createDocument() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled document' }),
      });
      if (!response.ok) throw new Error('Could not create the document');
      const created = await response.json();
      router.push(`/documents/${created.document.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the document');
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/documents/import', { method: 'POST', body });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error ?? 'Import failed');
      }
      const created = await response.json();
      router.push(`/documents/${created.document.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="field-row">
        <button className="primary" onClick={createDocument} disabled={busy}>
          New document
        </button>
        <button onClick={() => fileInput.current?.click()} disabled={busy}>
          Import DOCX, Markdown or text
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".docx,.md,.markdown,.txt,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = '';
          }}
        />
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {documents.length === 0 ? (
        <p className="panel-note">
          No documents yet. Create one, or import a manuscript to start from existing material.
        </p>
      ) : (
        documents.map((document) => (
          <a key={document.id} className="doc-row" href={`/documents/${document.id}`}>
            <strong>{document.title}</strong>
            <span className="chip">rev {document.currentRevision}</span>
            <small>{new Date(document.updatedAt).toLocaleString()}</small>
          </a>
        ))
      )}

      <p className="panel-note" style={{ marginTop: 28 }}>
        Storage: <strong>{storeKind === 'postgres' ? 'PostgreSQL' : 'local JSON files'}</strong>
        {storeKind === 'file' && ' - set DATABASE_URL and run npm run db:migrate to use PostgreSQL.'}
      </p>
    </>
  );
}
