'use client';

/**
 * Client-side editing session.
 *
 * Owns the Change Aggregator, the pending-change queue and autosave. Editor
 * transactions flow in through `handleUpdate`; meaningful changes flow out to
 * the ledger when the document is saved.
 *
 * No LLM request is made anywhere in this file - normal typing costs nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChangeAggregator } from '@/core/change-aggregator';
import { flattenBlocks } from '@/core/document';
import { newSessionId } from '@/core/ids';
import type { CheckpointRecord, DocumentContent, DraftChange } from '@/core/types';

/** How often the aggregator is asked for changes whose quiet period elapsed. */
const DRAIN_INTERVAL_MS = 750;
/** Quiet period before an edited document is written back. */
const AUTOSAVE_DELAY_MS = 2500;

export interface SessionState {
  revision: number;
  /** Edits not yet written to the ledger. */
  pendingCount: number;
  saving: boolean;
  lastSavedAt: string | null;
  error: string | null;
}

export interface UseDocumentSessionOptions {
  documentId: string;
  initialContent: DocumentContent;
  initialRevision: number;
  /** Called after a successful save, so the sidebar can refresh. */
  onSaved?: () => void;
}

export function useDocumentSession({
  documentId,
  initialContent,
  initialRevision,
  onSaved,
}: UseDocumentSessionOptions) {
  const sessionId = useMemo(() => newSessionId(), []);
  const aggregator = useMemo(
    () => new ChangeAggregator(flattenBlocks(initialContent), { sessionId }),
    // Rebuilt only if the document itself is swapped out.
    [initialContent, sessionId],
  );

  const queued = useRef<DraftChange[]>([]);
  const content = useRef<DocumentContent>(initialContent);
  const revision = useRef(initialRevision);
  const lastEditAt = useRef(0);
  const dirty = useRef(false);
  const savingRef = useRef(false);

  const [state, setState] = useState<SessionState>({
    revision: initialRevision,
    pendingCount: 0,
    saving: false,
    lastSavedAt: null,
    error: null,
  });

  const refreshPendingCount = useCallback(() => {
    setState((previous) => {
      const pendingCount = queued.current.length + aggregator.pendingCount;
      return pendingCount === previous.pendingCount ? previous : { ...previous, pendingCount };
    });
  }, [aggregator]);

  /** Called for every document-changing editor transaction. */
  const handleUpdate = useCallback(
    (next: DocumentContent) => {
      const now = Date.now();
      content.current = next;
      dirty.current = true;
      lastEditAt.current = now;
      aggregator.observe(flattenBlocks(next), now);
      refreshPendingCount();
    },
    [aggregator, refreshPendingCount],
  );

  const save = useCallback(
    async (options: { flushAll?: boolean } = {}): Promise<boolean> => {
      if (savingRef.current) return false;

      const drained = options.flushAll ? aggregator.drainAll(Date.now()) : [];
      const changes = [...queued.current, ...drained];
      queued.current = [];

      if (!dirty.current && changes.length === 0) {
        refreshPendingCount();
        return true;
      }

      savingRef.current = true;
      setState((previous) => ({ ...previous, saving: true, error: null }));

      const payload = {
        content: content.current,
        expectedRevision: revision.current,
        changes,
      };

      try {
        const response = await fetch(`/api/documents/${documentId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? `Save failed (${response.status})`);
        }

        const body = await response.json();
        revision.current = body.document.currentRevision;
        dirty.current = false;

        setState((previous) => ({
          ...previous,
          revision: body.document.currentRevision,
          saving: false,
          lastSavedAt: body.document.updatedAt,
          pendingCount: queued.current.length + aggregator.pendingCount,
          error: null,
        }));
        onSaved?.();
        return true;
      } catch (error) {
        // Put the changes back so nothing is lost when a save fails.
        queued.current = [...changes, ...queued.current];
        setState((previous) => ({
          ...previous,
          saving: false,
          pendingCount: queued.current.length + aggregator.pendingCount,
          error: error instanceof Error ? error.message : 'Save failed',
        }));
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [aggregator, documentId, onSaved, refreshPendingCount],
  );

  /** Drain matured changes, and autosave once editing goes quiet. */
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const drained = aggregator.drain(now);
      if (drained.length > 0) queued.current.push(...drained);
      refreshPendingCount();

      const quiet = now - lastEditAt.current >= AUTOSAVE_DELAY_MS;
      if (quiet && (dirty.current || queued.current.length > 0) && !savingRef.current) {
        void save();
      }
    }, DRAIN_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [aggregator, refreshPendingCount, save]);

  /** Warn before losing unsaved work. */
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty.current || queued.current.length > 0 || aggregator.pendingCount > 0) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [aggregator]);

  /**
   * Create a review boundary. Everything pending is flushed and saved first -
   * the ledger must never hold a change back across a checkpoint.
   */
  const createCheckpoint = useCallback(
    async (name: string): Promise<CheckpointRecord | null> => {
      const saved = await save({ flushAll: true });
      if (!saved) return null;

      const response = await fetch(`/api/documents/${documentId}/checkpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setState((previous) => ({
          ...previous,
          error: body.error ?? 'Could not create checkpoint',
        }));
        return null;
      }

      onSaved?.();
      return (await response.json()) as CheckpointRecord;
    },
    [documentId, onSaved, save],
  );

  /**
   * Adopt a document state produced on the server - the result of accepting an
   * AI proposal. The ledger entry for it was written there, so the aggregator
   * takes the new text as its baseline rather than recording it again.
   */
  const rebase = useCallback(
    (next: DocumentContent, nextRevision: number) => {
      content.current = next;
      revision.current = nextRevision;
      dirty.current = false;
      queued.current = [];
      lastEditAt.current = 0;
      aggregator.reset(flattenBlocks(next));

      setState((previous) => ({
        ...previous,
        revision: nextRevision,
        pendingCount: 0,
        lastSavedAt: new Date().toISOString(),
        error: null,
      }));
    },
    [aggregator],
  );

  return {
    state,
    handleUpdate,
    save,
    createCheckpoint,
    rebase,
    flushAndSave: () => save({ flushAll: true }),
  };
}
