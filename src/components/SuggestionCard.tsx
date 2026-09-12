'use client';

import { useState } from 'react';

import type { SuggestionRecord } from '@/core/types';

import { DiffView } from './DiffView';

export interface SuggestionCardProps {
  suggestion: SuggestionRecord;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onDiscuss: () => void;
  onRevise: (instruction: string) => void;
}

const STATUS_LABELS: Record<SuggestionRecord['status'], string> = {
  generated: 'Proposed',
  discussed: 'Under discussion',
  revised: 'Superseded',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

/**
 * A proposal, shown as before/after with its provenance.
 *
 * The author sees what would change before anything changes: nothing here
 * writes to the document except the explicit Accept.
 */
export function SuggestionCard({
  suggestion,
  busy,
  onAccept,
  onReject,
  onDiscuss,
  onRevise,
}: SuggestionCardProps) {
  const [revising, setRevising] = useState(false);
  const [instruction, setInstruction] = useState('');

  const open = suggestion.status === 'generated' || suggestion.status === 'discussed';

  return (
    <article className={`suggestion suggestion-${suggestion.status}`}>
      <div className="change-head">
        <span className={`chip${open ? ' substantive' : ''}`}>
          {STATUS_LABELS[suggestion.status]}
        </span>
        {suggestion.model && <span>{suggestion.model}</span>}
        <span style={{ marginLeft: 'auto' }}>from revision {suggestion.baseRevision}</span>
      </div>

      <p className="suggestion-instruction">&ldquo;{suggestion.instruction}&rdquo;</p>

      <DiffView before={suggestion.before} after={suggestion.proposed} />

      {suggestion.rationale && <p className="suggestion-rationale">{suggestion.rationale}</p>}

      {open ? (
        <>
          <div className="field-row" style={{ marginTop: 10, marginBottom: 0 }}>
            <button className="primary" disabled={busy} onClick={onAccept}>
              Accept
            </button>
            <button disabled={busy} onClick={onReject}>
              Reject
            </button>
            <button disabled={busy} onClick={onDiscuss}>
              Discuss
            </button>
            <button disabled={busy} onClick={() => setRevising((value) => !value)}>
              Revise
            </button>
          </div>

          {revising && (
            <div style={{ marginTop: 10 }}>
              <textarea
                rows={2}
                value={instruction}
                placeholder="What should the next attempt do differently?"
                disabled={busy}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <div className="field-row" style={{ marginBottom: 0 }}>
                <button
                  className="primary"
                  disabled={busy || !instruction.trim()}
                  onClick={() => {
                    onRevise(instruction.trim());
                    setInstruction('');
                    setRevising(false);
                  }}
                >
                  Propose again
                </button>
                <button disabled={busy} onClick={() => setRevising(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="suggestion-resolved">
          {suggestion.status === 'accepted'
            ? 'Accepted and written to the Change Ledger.'
            : suggestion.status === 'rejected'
              ? 'Rejected. The document was not touched.'
              : 'Superseded by a later proposal.'}
        </p>
      )}
    </article>
  );
}
