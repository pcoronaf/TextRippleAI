'use client';

import { useState } from 'react';

import type { DecisionConflict } from '@/core/decisions';
import type { DecisionRecord, DecisionScope, DecisionStatus } from '@/core/types';

export interface DecisionsPanelProps {
  decisions: DecisionRecord[];
  conflicts: DecisionConflict[];
  busy: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onCreate: (input: { title: string; description: string; scope: DecisionScope }) => void;
  onSetStatus: (decisionId: string, status: DecisionStatus) => void;
  /** The block currently selected, offered as a scope anchor. */
  anchorBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
}

const SCOPE_LABELS: Record<DecisionScope['type'], string> = {
  document: 'Whole document',
  node: 'This passage and its section',
  from_node: 'From this passage onwards',
};

const SOURCE_LABELS: Record<DecisionRecord['source'], string> = {
  manual: 'Recorded directly',
  conversation: 'From a conversation',
  impact_review: 'From an impact review',
};

/**
 * Decision memory.
 *
 * Recording a decision never edits the document. Its effect is on what the
 * system proposes next: the Context Builder sends applicable decisions with
 * every request, and impact analysis stops re-raising what one has settled.
 */
export function DecisionsPanel({
  decisions,
  conflicts,
  busy,
  query,
  onQueryChange,
  onCreate,
  onSetStatus,
  anchorBlockId,
  onSelectBlock,
}: DecisionsPanelProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scopeType, setScopeType] = useState<DecisionScope['type']>('document');
  const [showRetired, setShowRetired] = useState(false);

  const active = decisions.filter((decision) => decision.status === 'accepted');
  const shown = showRetired ? decisions : active;

  const conflictsFor = (decisionId: string) =>
    conflicts.filter((conflict) => conflict.a === decisionId || conflict.b === decisionId);

  return (
    <div className="panel">
      <div className="field-row">
        <input
          type="search"
          placeholder="Search decisions..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>

      {conflicts.length > 0 && (
        <div className="panel-note" style={{ marginBottom: 14, color: 'var(--danger)' }}>
          <strong>
            {conflicts.length} possible contradiction{conflicts.length === 1 ? '' : 's'} between
            decisions in force
          </strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {conflicts.map((conflict, index) => (
              <li key={index}>{conflict.explanation}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="decision-composer">
        <div className="pane-heading" style={{ padding: '0 0 6px' }}>
          Record a decision
        </div>
        <input
          type="text"
          placeholder="Prefer human oversight terminology"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <textarea
          rows={3}
          placeholder="Use 'human oversight' rather than 'human supervision' when discussing governance requirements."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="field-row" style={{ marginBottom: 0 }}>
          <select
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value as DecisionScope['type'])}
            style={{ flex: 1, minWidth: 0 }}
            disabled={!anchorBlockId && scopeType === 'document'}
          >
            <option value="document">{SCOPE_LABELS.document}</option>
            <option value="node" disabled={!anchorBlockId}>
              {SCOPE_LABELS.node}
            </option>
            <option value="from_node" disabled={!anchorBlockId}>
              {SCOPE_LABELS.from_node}
            </option>
          </select>
          <button
            className="primary"
            disabled={busy || !title.trim()}
            onClick={() => {
              const scope: DecisionScope =
                scopeType === 'document' || !anchorBlockId
                  ? { type: 'document' }
                  : { type: scopeType, nodeId: anchorBlockId };
              onCreate({ title: title.trim(), description: description.trim(), scope });
              setTitle('');
              setDescription('');
            }}
          >
            Record
          </button>
        </div>
        {scopeType !== 'document' && !anchorBlockId && (
          <p className="panel-note" style={{ marginTop: 8 }}>
            Select a passage in the document to scope a decision to it.
          </p>
        )}
      </div>

      {decisions.length > active.length && (
        <label style={{ display: 'block', margin: '14px 0', color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(event) => setShowRetired(event.target.checked)}
          />{' '}
          Show superseded and retired
        </label>
      )}

      {shown.length === 0 ? (
        <p className="panel-note" style={{ marginTop: 14 }}>
          No decisions recorded. A decision keeps the reasoning behind a choice where the system can
          find it - so it stops asking, and stops proposing what you have already refused.
        </p>
      ) : (
        shown.map((decision) => (
          <article key={decision.id} className={`decision decision-${decision.status}`}>
            <div className="change-head">
              <span className={`chip${decision.status === 'accepted' ? ' substantive' : ''}`}>
                {decision.status}
              </span>
              <span>{SCOPE_LABELS[decision.scope.type]}</span>
              {decision.scope.nodeId && (
                <button
                  className="block-id"
                  onClick={() => onSelectBlock(decision.scope.nodeId!)}
                  style={{ border: 'none', background: 'none', padding: 0 }}
                >
                  {decision.scope.nodeId}
                </button>
              )}
              <span style={{ marginLeft: 'auto' }}>{SOURCE_LABELS[decision.source]}</span>
            </div>

            <strong>{decision.title}</strong>
            {decision.description && <p className="decision-body">{decision.description}</p>}

            {decision.suppressBlockId && (
              <p className="decision-suppression">
                Stops impact analysis re-raising this passage
                {decision.suppressTerms.length > 0 &&
                  ` for ${decision.suppressTerms.map((term) => `"${term}"`).join(', ')}`}
                .
              </p>
            )}

            {conflictsFor(decision.id).map((conflict, index) => (
              <p key={index} className="decision-conflict">
                {conflict.explanation}
              </p>
            ))}

            {decision.status === 'accepted' && (
              <div className="field-row" style={{ marginTop: 8, marginBottom: 0 }}>
                <button disabled={busy} onClick={() => onSetStatus(decision.id, 'retired')}>
                  Retire
                </button>
              </div>
            )}
          </article>
        ))
      )}
    </div>
  );
}
