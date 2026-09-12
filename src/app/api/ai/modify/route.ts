import { NextResponse } from 'next/server';

import { buildAskContext } from '@/ai/context-builder';
import { complete } from '@/ai/gateway';
import {
  MODIFY_SYSTEM,
  buildModifyMessages,
  conversationTitle,
  parseModifyResponse,
} from '@/ai/prompts';
import { briefsFor } from '@/server/briefs';
import { getStore } from '@/store';
import { handleError } from '@/server/http';

export const maxDuration = 120;

/**
 * Propose a rewrite of one block.
 *
 * Nothing is written to the document. The result is an inert proposal that the
 * author reviews and either accepts or rejects - there is no code path from
 * here to the authoritative text.
 *
 * A revision of an earlier proposal passes `parentSuggestionId`; the parent is
 * marked superseded and the discussion so far is carried into the prompt.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    const blockId = typeof body.blockId === 'string' ? body.blockId : '';
    const instruction = String(body.instruction ?? '').trim();

    if (!documentId || !blockId) {
      return NextResponse.json({ error: 'documentId and blockId are required' }, { status: 400 });
    }
    if (!instruction) {
      return NextResponse.json({ error: 'An instruction is required' }, { status: 400 });
    }

    const store = getStore();
    const loaded = await store.getDocument(documentId);
    if (!loaded) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    const parent =
      typeof body.parentSuggestionId === 'string'
        ? await store.getSuggestion(documentId, body.parentSuggestionId)
        : null;

    // A revision continues the conversation the original was proposed in, so
    // the discussion that prompted it is part of the prompt.
    const conversationId = parent?.conversationId ?? body.conversationId;
    const existing =
      typeof conversationId === 'string'
        ? await store.getConversation(documentId, conversationId)
        : null;

    const history = existing ? await store.listMessages(documentId, existing.id) : [];
    const changes = await store.listChanges(documentId, { limit: 100 });

    const built = buildAskContext({
      document: loaded.document,
      content: loaded.content,
      blockId,
      // A rewrite replaces the whole block, so the block is what is sent; any
      // narrower highlight is passed separately as a hint about focus.
      highlight: typeof body.selectedText === 'string' ? body.selectedText : undefined,
      question: instruction,
      recentChanges: changes,
      briefs: await briefsFor(documentId, loaded.content, blockId),
      history,
      resendSurroundings: true,
      budgetTokens: typeof body.budgetTokens === 'number' ? body.budgetTokens : undefined,
    });

    let completion;
    try {
      completion = await complete({
        system: MODIFY_SYSTEM,
        messages: [
          ...built.history.map((message) => ({ role: message.role, content: message.content })),
          ...buildModifyMessages({ parts: built.parts, instruction }),
        ],
        tier: 'reasoning',
        maxTokens: 2000,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'The AI provider failed';
      return NextResponse.json({ error: detail }, { status: 502 });
    }

    const proposal = parseModifyResponse(completion.text);

    // A proposal is only worth reviewing if it is a conversation away from
    // being discussed, so give it one.
    const conversation =
      existing ??
      (await store.createConversation(documentId, {
        anchorBlockId: blockId,
        selection:
          body.selection && typeof body.selection.from === 'number'
            ? { from: body.selection.from, to: body.selection.to }
            : null,
        selectionText: built.selectedText,
        title: conversationTitle(instruction),
      }));

    const suggestion = await store.createSuggestion(documentId, {
      blockId,
      conversationId: conversation.id,
      instruction,
      before: built.block.text,
      proposed: proposal.proposed,
      rationale: proposal.rationale,
      selectionStart: typeof body.selection?.from === 'number' ? body.selection.from : null,
      selectionEnd: typeof body.selection?.to === 'number' ? body.selection.to : null,
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      contextDigest: built.digest,
      parentSuggestionId: parent?.id ?? null,
      baseRevision: loaded.document.currentRevision,
    });

    if (parent) {
      await store.setSuggestionStatus(documentId, parent.id, { status: 'revised' });
    }

    return NextResponse.json({ suggestion, context: built.digest, usage: completion.usage });
  } catch (error) {
    return handleError(error);
  }
}
