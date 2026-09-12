import { NextResponse } from 'next/server';

import { buildAskContext } from '@/ai/context-builder';
import { complete } from '@/ai/gateway';
import {
  ASK_SYSTEM,
  EXPLAIN_QUESTION,
  buildAskMessages,
  conversationTitle,
  tierFor,
  type AskAction,
} from '@/ai/prompts';
import { briefsFor } from '@/server/briefs';
import { getStore } from '@/store';
import { handleError } from '@/server/http';

// A reasoning-tier answer can take a while; do not cut it off early.
export const maxDuration = 120;

/**
 * Ask a question about a selected passage.
 *
 * The client sends a document ID, a block ID, the selected text and a question.
 * It does not decide what context the model receives - the server's Context
 * Builder does, under an explicit token budget, and returns a digest of exactly
 * what was sent.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    const blockId = typeof body.blockId === 'string' ? body.blockId : '';
    const action: AskAction = body.action === 'explain' ? 'explain' : 'ask';
    const question =
      action === 'explain' ? EXPLAIN_QUESTION : String(body.question ?? '').trim();

    if (!documentId || !blockId) {
      return NextResponse.json({ error: 'documentId and blockId are required' }, { status: 400 });
    }
    if (!question) {
      return NextResponse.json({ error: 'A question is required' }, { status: 400 });
    }

    const store = getStore();
    const loaded = await store.getDocument(documentId);
    if (!loaded) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    const existing =
      typeof body.conversationId === 'string'
        ? await store.getConversation(documentId, body.conversationId)
        : null;

    const history = existing ? await store.listMessages(documentId, existing.id) : [];
    const changes = await store.listChanges(documentId, { limit: 100 });

    const built = buildAskContext({
      document: loaded.document,
      content: loaded.content,
      blockId,
      selectionText: typeof body.selectedText === 'string' ? body.selectedText : undefined,
      question,
      recentChanges: changes,
      briefs: await briefsFor(documentId, loaded.content, blockId),
      history,
      budgetTokens: typeof body.budgetTokens === 'number' ? body.budgetTokens : undefined,
    });

    // The model is called before anything is written, so a provider failure
    // cannot leave a dangling user turn in the conversation.
    let completion;
    try {
      completion = await complete({
        system: ASK_SYSTEM,
        messages: buildAskMessages({
          parts: built.parts,
          history: built.history,
          question,
        }),
        tier: tierFor(action),
        maxTokens: 1200,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'The AI provider failed';
      return NextResponse.json({ error: detail }, { status: 502 });
    }

    const conversation =
      existing ??
      (await store.createConversation(documentId, {
        anchorBlockId: blockId,
        selection:
          body.selection && typeof body.selection.from === 'number'
            ? { from: body.selection.from, to: body.selection.to }
            : null,
        selectionText: built.selectedText,
        title: conversationTitle(question),
      }));

    // Token counts live on the assistant turn only; the user turn carries the
    // context digest, so totals are not double-counted.
    const userMessage = await store.appendMessage(documentId, conversation.id, {
      role: 'user',
      content: question,
      contextDigest: built.digest,
    });

    const assistantMessage = await store.appendMessage(documentId, conversation.id, {
      role: 'assistant',
      content: completion.text,
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
    });

    return NextResponse.json({
      conversation,
      messages: [userMessage, assistantMessage],
      context: built.digest,
      usage: completion.usage,
      model: completion.model,
      provider: completion.provider,
    });
  } catch (error) {
    return handleError(error);
  }
}
