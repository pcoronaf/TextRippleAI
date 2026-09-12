'use client';

import type { IndexStatusReport } from '@/core/types';

export interface IndexPanelProps {
  status: IndexStatusReport | null;
  busy: boolean;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: { nodeId: string; text: string; score: number; signals: Record<string, unknown> }[];
  onSelectBlock: (blockId: string) => void;
}

/**
 * The semantic index: what it holds, what has gone out of date, and a way to
 * search it. Refreshing is always an explicit act - nothing re-indexes on its
 * own, so the cost is never a surprise.
 */
export function IndexPanel({
  status,
  busy,
  onRefresh,
  onSearch,
  query,
  onQueryChange,
  results,
  onSelectBlock,
}: IndexPanelProps) {
  const staleSummaries =
    status?.summaries.reduce((sum, entry) => sum + entry.stale + entry.potentiallyStale, 0) ?? 0;
  const missingSummaries = status?.summaries.reduce((sum, entry) => sum + entry.missing, 0) ?? 0;
  const outstanding =
    (status?.embeddings.stale ?? 0) + (status?.embeddings.missing ?? 0) + staleSummaries + missingSummaries;

  return (
    <div className="panel">
      <div className="field-row">
        <input
          type="search"
          placeholder="Search this document..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearch(query);
          }}
        />
        <button onClick={() => onSearch(query)} disabled={busy || !query.trim()}>
          Search
        </button>
      </div>

      {results.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {results.map((hit) => (
            <article key={hit.nodeId} className="change">
              <div className="change-head">
                {(hit.signals.lexicalRank as number | null) !== null && (
                  <span className="chip">text #{String(hit.signals.lexicalRank)}</span>
                )}
                {(hit.signals.semanticRank as number | null) !== null && (
                  <span className="chip">semantic #{String(hit.signals.semanticRank)}</span>
                )}
                {Boolean(hit.signals.definition) && <span className="chip substantive">defines</span>}
                <button
                  className="block-id"
                  onClick={() => onSelectBlock(hit.nodeId)}
                  style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0 }}
                >
                  {hit.nodeId}
                </button>
              </div>
              <div className="diff">{hit.text.slice(0, 280)}</div>
            </article>
          ))}
        </div>
      )}

      {status && (
        <div className="panel-note" style={{ marginBottom: 12 }}>
          <strong>
            {outstanding === 0 ? 'Index is current' : `${outstanding} item(s) out of date`}
          </strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>
              Embeddings: {status.embeddings.current} current, {status.embeddings.stale} stale,{' '}
              {status.embeddings.missing} missing (of {status.blocks} blocks)
            </li>
            {status.summaries.map((entry) => (
              <li key={entry.type}>
                {entry.type} briefs: {entry.current} current, {entry.stale} stale,{' '}
                {entry.potentiallyStale} suspect, {entry.missing} missing
              </li>
            ))}
            <li>{status.semanticUnits} extracted terms, definitions and claims</li>
          </ul>
        </div>
      )}

      <button className="primary" onClick={onRefresh} disabled={busy}>
        {busy ? 'Indexing...' : 'Refresh index'}
      </button>
      <p className="panel-note" style={{ marginTop: 12 }}>
        Embeddings and summaries are regenerated only where the text beneath them has moved on.
        Extraction of terms, definitions and claims is local and costs nothing.
      </p>
    </div>
  );
}
