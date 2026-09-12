'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ContextDigest, ConversationRecord, MessageRecord } from '@/core/types';
import type { TokenUsage } from '@/ai/types';

import type { EditorSelection } from './EditorPane';

export interface AskPanelProps {
  documentId: string;
  selection: EditorSelection | null;
  /** Incremented by the floating toolbar to trigger an action. */
  trigger: { action: 'ask' | 'explain'; nonce: number } | null;
  onUsage: (usage: TokenUsage) => void;
}

interface AskResponse {
  conversation: ConversationRecord;
  messages: MessageRecord[];
  context: ContextDigest;
  error?: string;
}

export function AskPanel({ documentId, selection, trigger, onUsage }: AskPanelProps) {
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockId = selection?.blockId ?? null;
  const lastTrigger = useRef(0);

  /**
   * Re-selecting a paragraph resumes the conversation already anchored to it,
   * rather than starting a fresh one each time.
   */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError(null);
      if (!blockId) {
        setConversation(null);
        setMessages([]);
        return;
      }

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
  }, [blockId, documentId]);

  const send = useCallback(
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

  // The floating toolbar raises actions; run them once per click.
  useEffect(() => {
    if (!trigger || trigger.nonce === lastTrigger.current) return;
    lastTrigger.current = trigger.nonce;
    if (trigger.action === 'explain') void send('explain', '');
  }, [send, trigger]);

  if (!blockId) {
    return (
      <div className="panel">
        <p className="panel-note">
          Select a passage in the document, then ask about it. Nothing is sent to a model until you
          do - ordinary editing makes no request at all.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="selected-text">
        <div className="pane-heading" style={{ padding: '0 0 4px' }}>
          Selected text
        </div>
        <blockquote>{selection?.text || 'The whole paragraph.'}</blockquote>
        <span className="block-id">{blockId}</span>
      </div>

      {messages.length === 0 && !busy && (
        <p className="panel-note" style={{ marginTop: 12 }}>
          No conversation about this passage yet.
        </p>
      )}

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
              void send('ask', question);
            }
          }}
        />
        <div className="field-row" style={{ marginBottom: 0 }}>
          <button className="primary" disabled={busy || !question.trim()} onClick={() => void send('ask', question)}>
            Ask
          </button>
          <button disabled={busy} onClick={() => void send('explain', '')}>
            Explain
          </button>
        </div>
      </div>
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
