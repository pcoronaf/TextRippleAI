'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ContextDigest,
  ConversationRecord,
  DocumentContent,
  MessageRecord,
  SuggestionRecord,
} from '@/core/types';
import type { TokenUsage } from '@/ai/types';

import type { EditorSelection } from './EditorPane';
import { SuggestionCard } from './SuggestionCard';

export type AskAction = 'ask' | 'explain' | 'modify';

export interface AskPanelProps {
  documentId: string;
  /** The revision the author is reviewing against. */
  revision: number;
  selection: EditorSelection | null;
  /** Incremented by the floating toolbar to trigger an action. */
  trigger: { action: AskAction; nonce: number } | null;
  onUsage: (usage: TokenUsage) => void;
  /** Flush pending edits before a proposal is applied. Returns false if it failed. */
  onBeforeAccept: () => Promise<boolean>;
  /** A proposal was applied on the server; adopt the result. */
  onAccepted: (content: DocumentContent, revision: number) => void;
}

interface AskResponse {
  conversation: ConversationRecord;
  messages: MessageRecord[];
  context: ContextDigest;
  error?: string;
}

export function AskPanel({
  documentId,
  revision,
  selection,
  trigger,
  onUsage,
  onBeforeAccept,
  onAccepted,
}: AskPanelProps) {
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionRecord[]>([]);
  const [question, setQuestion] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockId = selection?.blockId ?? null;
  const lastTrigger = useRef(0);
  const instructionInput = useRef<HTMLTextAreaElement>(null);

  const loadSuggestions = useCallback(
    async (block: string) => {
      const response = await fetch(
        `/api/documents/${documentId}/suggestions?blockId=${encodeURIComponent(block)}`,
      );
      if (!response.ok) return;
      const body = await response.json();
      setSuggestions(body.suggestions ?? []);
    },
    [documentId],
  );

  /**
   * Re-selecting a paragraph resumes the conversation already anchored to it,
   * and shows the proposals already made about it.
   */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError(null);
      if (!blockId) {
        setConversation(null);
        setMessages([]);
        setSuggestions([]);
        return;
      }

      await loadSuggestions(blockId);

      const response = await fetch(
        `/api/documents/${documentId}/conversations?anchor=${encodeURIComponent(blockId)}`,
      );
      if (!response.ok || cancelled) return;

      const body = await response.json();
      const latest: ConversationRecord | undefined = body.conversations?.[0];

      if (!latest) {
        setConversation(null);
        setMessages([]);
        return;
      }

      const thread = await fetch(`/api/documents/${documentId}/conversations/${latest.id}`);
      if (!thread.ok || cancelled) return;

      const loaded = await thread.json();
      setConversation(loaded.conversation);
      setMessages(loaded.messages ?? []);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [blockId, documentId, loadSuggestions]);

  const ask = useCallback(
    async (action: 'ask' | 'explain', text: string) => {
      if (!blockId || busy) return;
      if (action === 'ask' && !text.trim()) return;

      setBusy(true);
      setError(null);

      try {
        const response = await fetch('/api/ai/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            documentId,
            blockId,
            action,
            question: text,
            selectedText: selection?.text || undefined,
            selection: selection ? { from: selection.from, to: selection.to } : undefined,
            conversationId: conversation?.id,
          }),
        });

        const body = (await response.json()) as AskResponse;
        if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

        setConversation(body.conversation);
        setMessages((previous) => [...previous, ...body.messages]);
        setQuestion('');

        const answer = body.messages.find((message) => message.role === 'assistant');
        if (answer) {
          onUsage({ inputTokens: answer.inputTokens, outputTokens: answer.outputTokens });
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Request failed');
      } finally {
        setBusy(false);
      }
    },
    [blockId, busy, conversation?.id, documentId, onUsage, selection],
  );

  const modify = useCallback(
    async (text: string, parentSuggestionId?: string) => {
      if (!blockId || busy || !text.trim()) return;

      setBusy(true);
      setError(null);

      try {
        const response = await fetch('/api/ai/modify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            documentId,
            blockId,
            instruction: text,
            selectedText: selection?.text || undefined,
            selection: selection ? { from: selection.from, to: selection.to } : undefined,
            conversationId: conversation?.id,
            parentSuggestionId,
          }),
        });

        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

        setInstruction('');
        onUsage(body.usage ?? { inputTokens: 0, outputTokens: 0 });
        await loadSuggestions(blockId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Request failed');
      } finally {
        setBusy(false);
      }
    },
    [blockId, busy, conversation?.id, documentId, loadSuggestions, onUsage, selection],
  );

  const resolve = useCallback(
    async (suggestion: SuggestionRecord, action: 'accept' | 'reject' | 'discuss') => {
      if (busy) return;
      setBusy(true);
      setError(null);

      try {
        // Everything pending must reach the ledger before the server applies a
        // proposal on top of it, or the two would disagree about the revision.
        if (action === 'accept') {
          const flushed = await onBeforeAccept();
          if (!flushed) throw new Error('Save your pending edits before accepting');
        }

        const response = await fetch(
          `/api/documents/${documentId}/suggestions/${suggestion.id}/resolve`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action,
              ...(action === 'accept' ? { expectedRevision: revision } : {}),
            }),
          },
        );

        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

        if (action === 'accept') onAccepted(body.content, body.document.currentRevision);
        if (blockId) await loadSuggestions(blockId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Request failed');
      } finally {
        setBusy(false);
      }
    },
    [blockId, busy, documentId, loadSuggestions, onAccepted, onBeforeAccept, revision],
  );

  // The floating toolbar raises actions; run each click once.
  useEffect(() => {
    if (!trigger || trigger.nonce === lastTrigger.current) return;
    lastTrigger.current = trigger.nonce;

    if (trigger.action === 'explain') void ask('explain', '');
    // A rewrite needs an instruction, so put the cursor where it is typed
    // rather than guessing what the author wants changed.
    if (trigger.action === 'modify') instructionInput.current?.focus();
  }, [ask, trigger]);

  if (!blockId) {
    return (
      <div className="panel">
        <p className="panel-note">
          Select a passage in the document, then ask about it or ask for a rewrite. Nothing is sent
          to a model until you do - ordinary editing makes no request at all.
        </p>
      </div>
    );
  }

  const open = suggestions.filter(
    (suggestion) => suggestion.status === 'generated' || suggestion.status === 'discussed',
  );
  const resolved = suggestions.filter(
    (suggestion) => suggestion.status !== 'generated' && suggestion.status !== 'discussed',
  );

  return (
    <div className="panel">
      <div className="selected-text">
        <div className="pane-heading" style={{ padding: '0 0 4px' }}>
          Selected text
        </div>
        <blockquote>{selection?.text || 'The whole paragraph.'}</blockquote>
        <span className="block-id">{blockId}</span>
      </div>

      {open.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          busy={busy}
          onAccept={() => void resolve(suggestion, 'accept')}
          onReject={() => void resolve(suggestion, 'reject')}
          onDiscuss={() => void resolve(suggestion, 'discuss')}
          onRevise={(text) => void modify(text, suggestion.id)}
        />
      ))}

      <div className="ask-composer" style={{ marginTop: 14 }}>
        <textarea
          ref={instructionInput}
          rows={2}
          value={instruction}
          placeholder="Rewrite this so that..."
          disabled={busy}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <div className="field-row" style={{ marginBottom: 0 }}>
          <button
            className="primary"
            disabled={busy || !instruction.trim()}
            onClick={() => void modify(instruction)}
          >
            Propose a rewrite
          </button>
        </div>
      </div>

      <div className="thread">
        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
        {busy && <p className="panel-note">Thinking...</p>}
      </div>

      {error && (
        <p className="panel-note" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="ask-composer">
        <textarea
          rows={3}
          value={question}
          placeholder="Ask about this text..."
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void ask('ask', question);
            }
          }}
        />
        <div className="field-row" style={{ marginBottom: 0 }}>
          <button
            className="primary"
            disabled={busy || !question.trim()}
            onClick={() => void ask('ask', question)}
          >
            Ask
          </button>
          <button disabled={busy} onClick={() => void ask('explain', '')}>
            Explain
          </button>
        </div>
      </div>

      {resolved.length > 0 && (
        <details className="resolved-suggestions">
          <summary>{resolved.length} resolved proposal(s)</summary>
          {resolved.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              busy={busy}
              onAccept={() => undefined}
              onReject={() => undefined}
              onDiscuss={() => undefined}
              onRevise={() => undefined}
            />
          ))}
        </details>
      )}
    </div>
  );
}

function MessageView({ message }: { message: MessageRecord }) {
  return (
    <article className={`message message-${message.role}`}>
      <div className="change-head">
        <span className="chip">{message.role === 'user' ? 'You' : 'AI'}</span>
        {message.model && <span>{message.model}</span>}
        {message.role === 'assistant' && (message.inputTokens > 0 || message.outputTokens > 0) && (
          <span style={{ marginLeft: 'auto' }}>
            {message.inputTokens} in / {message.outputTokens} out
          </span>
        )}
      </div>

      <div className="message-body">{message.content}</div>

      {message.contextDigest && <ContextDisclosure digest={message.contextDigest} />}
    </article>
  );
}

/** The spec's "Show AI context" control: exactly what left the machine. */
function ContextDisclosure({ digest }: { digest: ContextDigest }) {
  return (
    <details className="context-digest">
      <summary>
        Show AI context — {digest.totalTokens} tokens, {digest.documentPercent}% of the document
      </summary>

      {digest.parts.map((part) => (
        <div key={part.label} className="context-part">
          <strong>{part.label}</strong> <span className="chip">{part.tokens} tokens</span>
          <pre>{part.text}</pre>
        </div>
      ))}

      {digest.omitted.length > 0 && (
        <div className="context-part">
          <strong>Not sent</strong>
          <ul>
            {digest.omitted.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
