'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildOutline } from '@/core/document';
import { searchDecisions, type DecisionConflict } from '@/core/decisions';
import { useDocumentSession } from '@/editor/use-document-session';
import type { TokenUsage } from '@/ai/types';
import type {
  ChangeRecord,
  ChangesSinceSummary,
  CheckpointRecord,
  CommentRecord,
  DocumentContent,
  DocumentRecord,
  ImpactAnalysisRecord,
  ImpactRecord,
  ImpactStatusValue,
  DecisionRecord,
  DecisionScope,
  DecisionStatus,
  SuggestionRecord,
  IndexStatusReport,
  RetrievalHit,
} from '@/core/types';

import { EditorPane, type EditorSelection } from './EditorPane';
import type { Editor } from '@tiptap/react';
import type { AskAction } from './AskPanel';
import { ReviewSidebar, type SidebarTab } from './ReviewSidebar';
import type { AnchoredComment, CitationGroup } from './ReviewPanel';
import type { SettingsPanelProps, SettingsReport } from './SettingsPanel';

/** Counted in the browser so the author can see the cost of what they asked for. */
interface SessionUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

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

  const [tab, setTab] = useState<SidebarTab>('changes');
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [trigger, setTrigger] = useState<{ action: AskAction; nonce: number } | null>(null);
  const [usage, setUsage] = useState<SessionUsage>({ calls: 0, inputTokens: 0, outputTokens: 0 });
  const editorRef = useRef<Editor | null>(null);

  const [analysis, setAnalysis] = useState<ImpactAnalysisRecord | null>(null);
  const [impacts, setImpacts] = useState<ImpactRecord[]>([]);
  const [impactBusy, setImpactBusy] = useState(false);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Record<string, SuggestionRecord>>({});

  const [settings, setSettings] = useState<SettingsReport | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [conflicts, setConflicts] = useState<DecisionConflict[]>([]);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionQuery, setDecisionQuery] = useState('');

  const [comments, setComments] = useState<AnchoredComment[]>([]);
  const [citations, setCitations] = useState<CitationGroup[]>([]);
  const [changedBlockIds, setChangedBlockIds] = useState<string[]>([]);
  const [since, setSince] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);

  const [indexStatus, setIndexStatus] = useState<IndexStatusReport | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RetrievalHit[]>([]);

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

    // Index freshness moves with the ledger: every saved edit invalidates
    // something, and the status bar should say so.
    const status = await fetch(`/api/documents/${record.id}/index`).then((response) =>
      response.ok ? response.json() : null,
    );
    setIndexStatus(status);
  }, [hideTrivial, record.id, scope]);

  /**
   * Comments, citations and the set of changed blocks.
   *
   * All three read from the same review boundary, and none of them reaches a
   * model: the marks come from the ledger, the citations from what the index
   * already extracted, and a comment is a note between people.
   */
  const refreshReview = useCallback(async () => {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';

    const [commentBody, citationBody, ledger] = await Promise.all([
      fetch(`/api/documents/${record.id}/comments`).then((response) =>
        response.ok ? response.json() : { comments: [] },
      ),
      fetch(`/api/documents/${record.id}/citations${query}`).then((response) =>
        response.ok ? response.json() : { citations: [] },
      ),
      fetch(`/api/documents/${record.id}/changes${query}`).then((response) =>
        response.ok ? response.json() : { changes: [] },
      ),
    ]);

    setComments(commentBody.comments ?? []);
    setCitations(citationBody.citations ?? []);
    setChangedBlockIds([
      ...new Set((ledger.changes ?? []).map((change: ChangeRecord) => change.blockId)),
    ] as string[]);
  }, [record.id, since]);

  const refreshSettings = useCallback(async () => {
    const response = await fetch('/api/settings');
    if (!response.ok) return;
    setSettings(await response.json());
  }, []);

  // The body carries a key, so it goes out and the fresh report comes back;
  // nothing about it is kept in component state or logged.
  const saveSettings = useCallback(
    async (patch: Parameters<SettingsPanelProps['onSave']>[0]) => {
      setSettingsBusy(true);
      try {
        const response = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (response.ok) setSettings(await response.json());
      } finally {
        setSettingsBusy(false);
      }
    },
    [],
  );

  const refreshDecisions = useCallback(async () => {
    const response = await fetch(`/api/documents/${record.id}/decisions`);
    if (!response.ok) return;
    const body = await response.json();
    setDecisions(body.decisions ?? []);
    setConflicts(body.conflicts ?? []);
  }, [record.id]);

  const refreshIndex = useCallback(async () => {
    setIndexBusy(true);
    try {
      const response = await fetch(`/api/documents/${record.id}/index`, { method: 'POST' });
      if (response.ok) {
        const report = await response.json();
        setIndexStatus(report.status ?? null);
        if (report.tokens) {
          setUsage((previous) => ({
            calls: previous.calls + (report.summariesWritten > 0 ? 1 : 0),
            inputTokens: previous.inputTokens + report.tokens.input,
            outputTokens: previous.outputTokens + report.tokens.output,
          }));
        }
      }
    } finally {
      setIndexBusy(false);
    }
  }, [record.id]);

  const runSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) return setSearchResults([]);
      setIndexBusy(true);
      try {
        const response = await fetch(
          `/api/documents/${record.id}/search?q=${encodeURIComponent(query)}`,
        );
        const body = response.ok ? await response.json() : { hits: [] };
        setSearchResults(body.hits ?? []);
      } finally {
        setIndexBusy(false);
      }
    },
    [record.id],
  );

  const { state, handleUpdate, flushAndSave, createCheckpoint, rebase } = useDocumentSession({
    documentId: record.id,
    initialContent,
    initialRevision: record.currentRevision,
    onSaved: () => void refresh(),
  });

  useEffect(() => {
    void refresh();
    void refreshDecisions();
    void refreshReview();
    void refreshSettings();
  }, [refresh, refreshDecisions, refreshReview, refreshSettings]);

  const onEditorChange = useCallback(
    (next: DocumentContent) => {
      setContent(next);
      handleUpdate(next);
    },
    [handleUpdate],
  );

  const onAskAction = useCallback((action: AskAction) => {
    setTab('ask');
    setTrigger({ action, nonce: Date.now() });
  }, []);

  const scrollToBlock = useCallback((blockId: string) => {
    const target = window.document.querySelector<HTMLElement>(`[data-id="${blockId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('block-highlight');
    setTimeout(() => target.classList.remove('block-highlight'), 1600);
  }, []);

  /**
   * Adopt a proposal the server has applied.
   *
   * The editor content is replaced without emitting an update, and the session
   * is rebased onto the new revision - the ledger entry for this edit was
   * written server-side, so the aggregator must not record it a second time as
   * if the author had typed it.
   */
  const onAccepted = useCallback(
    (next: DocumentContent, nextRevision: number) => {
      editorRef.current?.commands.setContent(next, false);
      setContent(next);
      rebase(next, nextRevision);
      void refresh();
    },
    [rebase, refresh],
  );

  const onUsage = useCallback((turn: TokenUsage) => {
    setUsage((previous) => ({
      calls: previous.calls + 1,
      inputTokens: previous.inputTokens + turn.inputTokens,
      outputTokens: previous.outputTokens + turn.outputTokens,
    }));
  }, []);

  const analyseImpact = useCallback(async () => {
    setImpactBusy(true);
    setImpactError(null);
    try {
      // Everything pending must reach the ledger first, or the analysis would
      // examine a document the author has already moved past.
      await flushAndSave();

      const response = await fetch(`/api/documents/${record.id}/impact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ since: scope }),
      });

      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Analysis failed (${response.status})`);

      setAnalysis(body.analysis);
      setImpacts(body.impacts ?? []);
      setUsage((previous) => ({
        calls: previous.calls + (body.analysis?.model ? 1 : 0),
        inputTokens: previous.inputTokens + (body.analysis?.inputTokens ?? 0),
        outputTokens: previous.outputTokens + (body.analysis?.outputTokens ?? 0),
      }));
      await refresh();
    } catch (cause) {
      setImpactError(cause instanceof Error ? cause.message : 'Analysis failed');
    } finally {
      setImpactBusy(false);
    }
  }, [flushAndSave, record.id, refresh, scope]);

  /** Draft an edit that resolves a finding. Writes nothing to the document. */
  const proposeForImpact = useCallback(
    async (impactId: string) => {
      setImpactBusy(true);
      setImpactError(null);
      try {
        const response = await fetch(
          `/api/documents/${record.id}/impacts/${impactId}/propose`,
          { method: 'POST' },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Could not draft a fix (${response.status})`);

        setProposals((previous) => ({ ...previous, [impactId]: body.suggestion }));
        setImpacts((previous) =>
          previous.map((impact) => (impact.id === impactId ? body.impact : impact)),
        );
      } catch (cause) {
        setImpactError(cause instanceof Error ? cause.message : 'Could not draft a fix');
      } finally {
        setImpactBusy(false);
      }
    },
    [record.id],
  );

  /** Accept a drafted fix through the ordinary suggestion path. */
  const acceptProposal = useCallback(
    async (suggestionId: string) => {
      setImpactBusy(true);
      setImpactError(null);
      try {
        const flushed = await flushAndSave();
        if (!flushed) throw new Error('Save your pending edits before accepting');

        const response = await fetch(
          `/api/documents/${record.id}/suggestions/${suggestionId}/resolve`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'accept', expectedRevision: state.revision }),
          },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Could not accept (${response.status})`);

        onAccepted(body.content, body.document.currentRevision);
        setProposals((previous) => {
          const next = { ...previous };
          for (const [impactId, proposal] of Object.entries(next)) {
            if (proposal.id === suggestionId) next[impactId] = body.suggestion;
          }
          return next;
        });
      } catch (cause) {
        setImpactError(cause instanceof Error ? cause.message : 'Could not accept');
      } finally {
        setImpactBusy(false);
      }
    },
    [flushAndSave, onAccepted, record.id, state.revision],
  );

  const rejectProposal = useCallback(
    async (suggestionId: string) => {
      setImpactBusy(true);
      try {
        const response = await fetch(
          `/api/documents/${record.id}/suggestions/${suggestionId}/resolve`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'reject' }),
          },
        );
        if (response.ok) {
          const body = await response.json();
          setProposals((previous) => {
            const next = { ...previous };
            for (const [impactId, proposal] of Object.entries(next)) {
              if (proposal.id === suggestionId) next[impactId] = body.suggestion;
            }
            return next;
          });
        }
      } finally {
        setImpactBusy(false);
      }
    },
    [record.id],
  );

  /**
   * Take a finding into the Ask panel.
   *
   * Scrolling to the passage moves the editor selection there, which is what
   * the Ask panel anchors to - so the conversation opens on the right block
   * without a second mechanism for saying which one.
   */
  const discussImpact = useCallback(
    (impact: ImpactRecord) => {
      scrollToBlock(impact.targetBlockId);
      setTab('ask');
    },
    [scrollToBlock],
  );


  const createDecision = useCallback(
    async (input: {
      title: string;
      description: string;
      scope: DecisionScope;
      source?: DecisionRecord['source'];
      suppressBlockId?: string | null;
      suppressTerms?: string[];
      sourceImpactId?: string | null;
    }) => {
      setDecisionBusy(true);
      try {
        const response = await fetch(`/api/documents/${record.id}/decisions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (response.ok) await refreshDecisions();
      } finally {
        setDecisionBusy(false);
      }
    },
    [record.id, refreshDecisions],
  );

  const setDecisionStatus = useCallback(
    async (decisionId: string, status: DecisionStatus) => {
      setDecisionBusy(true);
      try {
        const response = await fetch(`/api/documents/${record.id}/decisions/${decisionId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (response.ok) await refreshDecisions();
      } finally {
        setDecisionBusy(false);
      }
    },
    [record.id, refreshDecisions],
  );

  const resolveImpact = useCallback(
    async (impactId: string, status: ImpactStatusValue) => {
      setImpactBusy(true);
      try {
        const response = await fetch(`/api/documents/${record.id}/impacts/${impactId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (response.ok) {
          const body = await response.json();
          setImpacts((previous) =>
            previous.map((impact) => (impact.id === impactId ? body.impact : impact)),
          );
        }
      } finally {
        setImpactBusy(false);
      }
    },
    [record.id],
  );

  /**
   * Turn a refusal into memory.
   *
   * The spec's example: the analysis says Chapter 8 should follow the same
   * terminology change; the author says no, Chapter 8 is about something else.
   * Recording that stops the next analysis raising it again - scoped to this
   * passage alone, rather than silencing the subject everywhere.
   */
  const recordDecisionFromImpact = useCallback(
    async (impact: ImpactRecord, reason: string) => {
      await createDecision({
        title: 'Do not propagate to this passage',
        description: reason,
        scope: { type: 'node', nodeId: impact.targetBlockId },
        source: 'impact_review',
        suppressBlockId: impact.targetBlockId,
        sourceImpactId: impact.id,
      });
      await resolveImpact(impact.id, 'accepted_no_change');
    },
    [createDecision, resolveImpact],
  );

  const addComment = useCallback(
    async (blockId: string, body: string) => {
      setReviewBusy(true);
      try {
        const response = await fetch(`/api/documents/${record.id}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blockId, body }),
        });
        if (response.ok) await refreshReview();
      } finally {
        setReviewBusy(false);
      }
    },
    [record.id, refreshReview],
  );

  const resolveComment = useCallback(
    async (commentId: string, status: CommentRecord['status']) => {
      setReviewBusy(true);
      try {
        const response = await fetch(`/api/documents/${record.id}/comments/${commentId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (response.ok) await refreshReview();
      } finally {
        setReviewBusy(false);
      }
    },
    [record.id, refreshReview],
  );

  const outline = useMemo(() => buildOutline(content), [content]);


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
            onSelectionChange={setSelection}
            onAskAction={onAskAction}
            changedBlockIds={showChanges ? changedBlockIds : []}
            onEditorReady={(instance) => {
              editorRef.current = instance;
            }}
          />
        </main>

        <aside className="pane">
          <ReviewSidebar
            tab={tab}
            onTabChange={setTab}
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
            ask={{
              documentId: record.id,
              revision: state.revision,
              selection,
              trigger,
              onUsage,
              onBeforeAccept: flushAndSave,
              onAccepted,
            }}
            index={{
              status: indexStatus,
              busy: indexBusy,
              onRefresh: () => void refreshIndex(),
              onSearch: (query) => void runSearch(query),
              query: searchQuery,
              onQueryChange: setSearchQuery,
              results: searchResults,
              onSelectBlock: scrollToBlock,
            }}
            impact={{
              analysis,
              impacts,
              checkpoints,
              scope,
              onScopeChange: setScope,
              busy: impactBusy,
              error: impactError,
              onAnalyse: () => void analyseImpact(),
              onResolve: (impactId, status) => void resolveImpact(impactId, status),
              onSelectBlock: scrollToBlock,
              proposals,
              onPropose: (impactId) => void proposeForImpact(impactId),
              onAcceptProposal: (suggestionId) => void acceptProposal(suggestionId),
              onRejectProposal: (suggestionId) => void rejectProposal(suggestionId),
              onDiscuss: discussImpact,
              onRecordDecision: recordDecisionFromImpact,
            }}
            decisions={{
              decisions: decisionQuery ? searchDecisions(decisions, decisionQuery) : decisions,
              conflicts,
              busy: decisionBusy,
              query: decisionQuery,
              onQueryChange: setDecisionQuery,
              onCreate: (input) => void createDecision(input),
              onSetStatus: (decisionId, status) => void setDecisionStatus(decisionId, status),
              anchorBlockId: selection?.blockId ?? null,
              onSelectBlock: scrollToBlock,
            }}
            settings={{
              report: settings,
              busy: settingsBusy,
              onSave: saveSettings,
            }}
            review={{
              comments,
              citations,
              checkpoints,
              since,
              onSinceChange: setSince,
              showChanges,
              onShowChangesChange: setShowChanges,
              changedCount: changedBlockIds.length,
              anchorBlockId: selection?.blockId ?? null,
              busy: reviewBusy,
              onComment: (blockId, body) => void addComment(blockId, body),
              onResolveComment: (commentId, status) => void resolveComment(commentId, status),
              onSelectBlock: scrollToBlock,
            }}
          />
        </aside>
      </div>

      <footer className="statusbar">
        <span>
          {state.pendingCount} pending change{state.pendingCount === 1 ? '' : 's'}
        </span>
        <span>revision {state.revision}</span>
        {indexStatus && (
          <span title="Summaries whose text has moved on. Refresh the index when you need them.">
            {indexStatus.summaries.reduce(
              (sum, entry) => sum + entry.stale + entry.potentiallyStale,
              0,
            )}{' '}
            stale summaries
          </span>
        )}
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
        <span style={{ flex: 1 }} />
        <span title="Editing never calls a model; only the actions you take do.">
          {usage.calls} LLM call{usage.calls === 1 ? '' : 's'} this session
          {usage.calls > 0 && ` · ${usage.inputTokens + usage.outputTokens} tokens`}
        </span>
        {state.error && <span className="error">{state.error}</span>}
      </footer>
    </div>
  );
}
