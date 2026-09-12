'use client';

import { useState } from 'react';

import type {
  CheckpointRecord,
  ImpactAnalysisRecord,
  ImpactRecord,
  ImpactStatusValue,
} from '@/core/types';

export interface ImpactPanelProps {
  analysis: ImpactAnalysisRecord | null;
  impacts: ImpactRecord[];
  checkpoints: CheckpointRecord[];
  scope: string | null;
  onScopeChange: (checkpointId: string | null) => void;
  busy: boolean;
  error: string | null;
  onAnalyse: () => void;
  onResolve: (impactId: string, status: ImpactStatusValue) => void;
  onSelectBlock: (blockId: string) => void;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const TYPE_LABELS: Record<string, string> = {
  terminology_consistency: 'Terminology',
  definition_conflict: 'Definition',
  contradiction: 'Contradiction',
  cross_reference: 'Cross-reference',
  numeric_dependency: 'Numeric',
  citation: 'Citation',
  scope: 'Scope',
  conclusion_dependency: 'Conclusion',
  other: 'Other',
};

const ACTION_LABELS: Record<string, string> = {
  revise: 'Revise',
  review: 'Review manually',
  no_change: 'No change recommended',
};

const STATUS_LABELS: Record<ImpactStatusValue, string> = {
  pending: 'Pending',
  dismissed: 'Dismissed',
  accepted_no_change: 'No change needed',
  needs_review: 'Marked for review',
  generate_suggestion: 'Queued for a proposal',
};

/**
 * The impact briefing.
 *
 * Findings only: nothing in this panel edits the document. Each one is resolved
 * by the author, and a dismissal is kept as review history rather than deleted.
 */
export function ImpactPanel({
  analysis,
  impacts,
  checkpoints,
  scope,
  onScopeChange,
  busy,
  error,
  onAnalyse,
  onResolve,
  onSelectBlock,
}: ImpactPanelProps) {
  const [showResolved, setShowResolved] = useState(false);

  const open = impacts.filter((impact) => impact.status === 'pending');
  const resolved = impacts.filter((impact) => impact.status !== 'pending');
  const shown = [...(showResolved ? impacts : open)].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
      b.confidence - a.confidence,
  );

  return (
    <div className="panel">
      <div className="field-row">
        <select
          value={scope ?? ''}
          onChange={(event) => onScopeChange(event.target.value || null)}
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">All changes</option>
          {checkpoints.map((checkpoint) => (
            <option key={checkpoint.id} value={checkpoint.id}>
              Since &ldquo;{checkpoint.name}&rdquo;
            </option>
          ))}
        </select>
        <button className="primary" onClick={onAnalyse} disabled={busy}>
          {busy ? 'Analysing...' : 'Analyse'}
        </button>
      </div>

      {error && (
        <p className="panel-note" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {!analysis && !error && (
        <p className="panel-note">
          Analyse the changes you have accumulated to see what elsewhere in the document may depend
          on them. Nothing is edited: the result is a briefing you act on finding by finding.
        </p>
      )}

      {analysis && (
        <>
          <div className="panel-note" style={{ marginBottom: 14 }}>
            <strong>{analysis.summary || 'Analysis complete.'}</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              <li>
                {analysis.changesAnalysed} change{analysis.changesAnalysed === 1 ? '' : 's'} analysed
                {analysis.changesFiltered > 0 &&
                  `, ${analysis.changesFiltered} typographical ignored`}
              </li>
              <li>
                collapsed into {analysis.clusters.length} conceptual change
                {analysis.clusters.length === 1 ? '' : 's'}
              </li>
              <li>
                {analysis.retrieval.candidatesConsidered} of {analysis.retrieval.blocksInDocument}{' '}
                passages examined ({analysis.retrieval.reductionPercent}% of the document ruled out
                before reasoning)
              </li>
              {analysis.model && (
                <li>
                  {analysis.model} — {analysis.inputTokens} in / {analysis.outputTokens} out
                </li>
              )}
            </ul>
          </div>

          {analysis.clusters.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="pane-heading" style={{ padding: '0 0 6px' }}>
                What changed
              </div>
              {analysis.clusters.map((cluster) => (
                <div key={cluster.id} className="change-head">
                  <span className="chip substantive">{cluster.classification}</span>
                  <span>{cluster.label}</span>
                </div>
              ))}
            </div>
          )}

          {analysis.status === 'failed' && (
            <p className="panel-note" style={{ color: 'var(--danger)' }}>
              {analysis.error ?? 'The analysis failed.'} The changes remain pending, so nothing was
              lost.
            </p>
          )}

          {impacts.length === 0 && analysis.status === 'completed' && (
            <p className="panel-note">
              No downstream consequences found. That is a real result, not an empty one.
            </p>
          )}

          {resolved.length > 0 && (
            <label style={{ display: 'block', margin: '10px 0', color: 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(event) => setShowResolved(event.target.checked)}
              />{' '}
              Show {resolved.length} resolved finding{resolved.length === 1 ? '' : 's'}
            </label>
          )}

          {shown.map((impact) => (
            <article key={impact.id} className={`impact impact-${impact.severity}`}>
              <div className="change-head">
                <span className={`chip${impact.severity === 'high' ? ' substantive' : ''}`}>
                  {impact.severity}
                </span>
                <span>{TYPE_LABELS[impact.impactType] ?? impact.impactType}</span>
                <span>{Math.round(impact.confidence * 100)}% confident</span>
                <button
                  className="block-id"
                  onClick={() => onSelectBlock(impact.targetBlockId)}
                  style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0 }}
                  title="Scroll to this passage"
                >
                  {impact.targetBlockId}
                </button>
              </div>

              <p className="impact-explanation">{impact.explanation}</p>
              <blockquote className="impact-target">{impact.targetText.slice(0, 320)}</blockquote>

              <div className="change-head" style={{ marginTop: 8 }}>
                <span>Recommended: {ACTION_LABELS[impact.recommendedAction]}</span>
              </div>

              {impact.status === 'pending' ? (
                <div className="field-row" style={{ marginTop: 8, marginBottom: 0 }}>
                  <button
                    disabled={busy}
                    onClick={() => onResolve(impact.id, 'generate_suggestion')}
                    title="Queued for a proposal; generating it arrives in M6"
                  >
                    Act on this
                  </button>
                  <button disabled={busy} onClick={() => onResolve(impact.id, 'needs_review')}>
                    Review later
                  </button>
                  <button disabled={busy} onClick={() => onResolve(impact.id, 'accepted_no_change')}>
                    No change needed
                  </button>
                  <button disabled={busy} onClick={() => onResolve(impact.id, 'dismissed')}>
                    Dismiss
                  </button>
                </div>
              ) : (
                <p className="suggestion-resolved">{STATUS_LABELS[impact.status]}</p>
              )}
            </article>
          ))}
        </>
      )}
    </div>
  );
}
