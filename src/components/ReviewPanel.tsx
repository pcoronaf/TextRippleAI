'use client';

import { useState } from 'react';

import type { CheckpointRecord, CommentRecord } from '@/core/types';

export interface CitationGroup {
  value: string;
  blockIds: string[];
  changedBlockIds: string[];
}

export interface ReviewPanelProps {
  comments: CommentRecord[];
  citations: CitationGroup[];
  checkpoints: CheckpointRecord[];
  /** The review boundary both the marks and the citation check work from. */
  since: string | null;
  onSinceChange: (checkpointId: string | null) => void;
  showChanges: boolean;
  onShowChangesChange: (value: boolean) => void;
  changedCount: number;
  anchorBlockId: string | null;
  busy: boolean;
  onComment: (blockId: string, body: string) => void;
  onResolveComment: (commentId: string, status: CommentRecord['status']) => void;
  onSelectBlock: (blockId: string) => void;
}

/**
 * Review: what people said, what changed, and which sources may have drifted.
 *
 * Nothing here reaches a model. Comments are notes between people, the change
 * marks are drawn from the ledger, and the citation check is a query over what
 * the index already extracted.
 */
export function ReviewPanel({
  comments,
  citations,
  checkpoints,
  since,
  onSinceChange,
  showChanges,
  onShowChangesChange,
  changedCount,
  anchorBlockId,
  busy,
  onComment,
  onResolveComment,
  onSelectBlock,
}: ReviewPanelProps) {
  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const open = comments.filter((comment) => comment.status === 'open');
  const shown = showResolved ? comments : open;
  const drifted = citations.filter((entry) => entry.changedBlockIds.length > 0);

  return (
    <div className="panel">
      <div className="field-row">
        <select
          value={since ?? ''}
          onChange={(event) => onSinceChange(event.target.value || null)}
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

      <label style={{ display: 'block', marginBottom: 16, color: 'var(--text-muted)' }}>
        <input
          type="checkbox"
          checked={showChanges}
          onChange={(event) => onShowChangesChange(event.target.checked)}
        />{' '}
        Mark the {changedCount} changed passage{changedCount === 1 ? '' : 's'} in the document
      </label>

      <div className="pane-heading" style={{ padding: '0 0 6px' }}>
        Comments
      </div>

      <div className="ask-composer">
        <textarea
          rows={2}
          placeholder={
            anchorBlockId ? 'Leave a note on the selected passage...' : 'Select a passage to comment on'
          }
          value={body}
          disabled={busy || !anchorBlockId}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="field-row" style={{ marginBottom: 0 }}>
          <button
            className="primary"
            disabled={busy || !anchorBlockId || !body.trim()}
            onClick={() => {
              if (!anchorBlockId) return;
              onComment(anchorBlockId, body.trim());
              setBody('');
            }}
          >
            Comment
          </button>
        </div>
      </div>

      {comments.length > open.length && (
        <label style={{ display: 'block', margin: '12px 0', color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
          />{' '}
          Show resolved
        </label>
      )}

      {shown.length === 0 ? (
        <p className="panel-note" style={{ marginTop: 12 }}>
          No comments yet.
        </p>
      ) : (
        shown.map((comment) => (
          <article key={comment.id} className={`comment comment-${comment.status}`}>
            <div className="change-head">
              <span className="chip">{comment.status}</span>
              <button
                className="block-id"
                onClick={() => onSelectBlock(comment.blockId)}
                style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0 }}
              >
                {comment.blockId}
              </button>
            </div>
            <p className="comment-body">{comment.body}</p>
            <div className="field-row" style={{ marginTop: 6, marginBottom: 0 }}>
              <button
                disabled={busy}
                onClick={() =>
                  onResolveComment(comment.id, comment.status === 'open' ? 'resolved' : 'open')
                }
              >
                {comment.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
            </div>
          </article>
        ))
      )}

      <div className="pane-heading" style={{ padding: '18px 0 6px' }}>
        Citations
      </div>

      {citations.length === 0 ? (
        <p className="panel-note">
          No citations found. They are extracted when the index is refreshed.
        </p>
      ) : (
        <>
          {drifted.length > 0 && (
            <p className="panel-note" style={{ marginBottom: 12, color: 'var(--danger)' }}>
              {drifted.length} source{drifted.length === 1 ? '' : 's'} cited by a passage that has
              changed. A source chosen to support a claim may not support what the claim now says.
            </p>
          )}

          {citations.map((entry) => (
            <div key={entry.value} className="citation">
              <div className="change-head" style={{ marginBottom: 4 }}>
                <strong className="block-id">{entry.value}</strong>
                <span style={{ marginLeft: 'auto' }}>
                  {entry.blockIds.length} passage{entry.blockIds.length === 1 ? '' : 's'}
                </span>
              </div>
              {entry.changedBlockIds.length > 0 && (
                <div className="change-head" style={{ marginBottom: 0 }}>
                  <span className="chip substantive">changed</span>
                  {entry.changedBlockIds.map((blockId) => (
                    <button
                      key={blockId}
                      className="block-id"
                      onClick={() => onSelectBlock(blockId)}
                      style={{ border: 'none', background: 'none', padding: 0 }}
                    >
                      {blockId}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
