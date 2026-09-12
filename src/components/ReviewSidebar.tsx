'use client';

import { useState } from 'react';

import { CLASSIFICATION_LABELS, isTrivial } from '@/core/classify';
import type { ChangeRecord, ChangesSinceSummary, CheckpointRecord } from '@/core/types';

import { AskPanel, type AskPanelProps } from './AskPanel';
import { DiffView } from './DiffView';

export type SidebarTab = 'changes' | 'checkpoints' | 'ask' | 'impact' | 'decisions';

export interface ReviewSidebarProps {
  changes: ChangeRecord[];
  summary: ChangesSinceSummary | null;
  checkpoints: CheckpointRecord[];
  /** Checkpoint the change list is scoped to; null means the whole ledger. */
  scope: string | null;
  onScopeChange: (checkpointId: string | null) => void;
  hideTrivial: boolean;
  onHideTrivialChange: (value: boolean) => void;
  onCreateCheckpoint: (name: string) => Promise<void>;
  onSelectBlock: (blockId: string) => void;
  busy: boolean;
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  ask: AskPanelProps;
}

const OPERATION_LABELS: Record<string, string> = {
  insert: 'Added',
  delete: 'Removed',
  replace: 'Edited',
  move: 'Moved',
};

export function ReviewSidebar(props: ReviewSidebarProps) {
  const { tab, onTabChange } = props;

  return (
    <>
      <div className="tabs" role="tablist">
        {(
          [
            ['changes', 'Changes'],
            ['checkpoints', 'Checkpoints'],
            ['ask', 'Ask'],
            ['impact', 'Impact'],
            ['decisions', 'Decisions'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => onTabChange(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'changes' && <ChangesPanel {...props} />}
      {tab === 'checkpoints' && <CheckpointsPanel {...props} />}
      {tab === 'ask' && <AskPanel {...props.ask} />}
      {tab === 'impact' && (
        <div className="panel">
          <p className="panel-note">
            Impact analysis arrives in M5. It depends on the Change Ledger and stable node
            identities being reliable first - which is what this milestone establishes.
          </p>
        </div>
      )}
      {tab === 'decisions' && (
        <div className="panel">
          <p className="panel-note">
            Decision memory arrives in M7, so authorial reasoning outlives the conversation that
            produced it.
          </p>
        </div>
      )}
    </>
  );
}

function ChangesPanel({
  changes,
  summary,
  checkpoints,
  scope,
  onScopeChange,
  hideTrivial,
  onHideTrivialChange,
  onSelectBlock,
}: ReviewSidebarProps) {
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
      </div>

      <label style={{ display: 'block', marginBottom: 14, color: 'var(--text-muted)' }}>
        <input
          type="checkbox"
          checked={hideTrivial}
          onChange={(event) => onHideTrivialChange(event.target.checked)}
        />{' '}
        Hide typographical changes
      </label>

      {summary && summary.byChapter.length > 0 && (
        <div className="panel-note" style={{ marginBottom: 14 }}>
          <strong>
            {summary.total} change{summary.total === 1 ? '' : 's'}
          </strong>
          {summary.trivial > 0 && ` (${summary.trivial} typographical)`}
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {summary.byChapter.map((chapter) => (
              <li key={chapter.chapterId ?? 'front'}>
                {chapter.title} &mdash; {chapter.count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {changes.length === 0 ? (
        <p className="panel-note">
          No changes recorded yet. Edit a paragraph and pause - the aggregator groups a burst of
          typing into one meaningful change.
        </p>
      ) : (
        changes.map((change) => (
          <article key={change.id} className="change">
            <div className="change-head">
              <span className={`chip${isTrivial(change.classification) ? '' : ' substantive'}`}>
                {CLASSIFICATION_LABELS[change.classification]}
              </span>
              <span>{OPERATION_LABELS[change.operation] ?? change.operation}</span>
              <button
                className="block-id"
                onClick={() => onSelectBlock(change.blockId)}
                style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0 }}
                title="Scroll to this block"
              >
                {change.blockId}
              </button>
            </div>
            <DiffView before={change.before} after={change.after} />
            <div className="change-head" style={{ marginTop: 8, marginBottom: 0 }}>
              <span>rev {change.revision}</span>
              <span>{change.source === 'human' ? 'manual' : change.source}</span>
              <span style={{ marginLeft: 'auto' }}>
                {new Date(change.createdAt).toLocaleTimeString()}
              </span>
            </div>
          </article>
        ))
      )}
    </div>
  );
}

function CheckpointsPanel({ checkpoints, onCreateCheckpoint, busy }: ReviewSidebarProps) {
  const [name, setName] = useState('');

  return (
    <div className="panel">
      <p className="panel-note" style={{ marginBottom: 14 }}>
        A checkpoint marks a review boundary - &ldquo;Methodology approved&rdquo;, &ldquo;Supervisor
        review&rdquo;. Everything pending is flushed to the ledger before one is created.
      </p>

      <div className="field-row">
        <input
          type="text"
          placeholder="Checkpoint name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            await onCreateCheckpoint(name.trim());
            setName('');
          }}
        >
          Create
        </button>
      </div>

      {checkpoints.length === 0 ? (
        <p className="panel-note">No checkpoints yet.</p>
      ) : (
        checkpoints.map((checkpoint) => (
          <div key={checkpoint.id} className="checkpoint">
            <div>
              <strong>{checkpoint.name}</strong>
              <br />
              <small>revision {checkpoint.revision}</small>
            </div>
            <small>{new Date(checkpoint.createdAt).toLocaleString()}</small>
          </div>
        ))
      )}
    </div>
  );
}
