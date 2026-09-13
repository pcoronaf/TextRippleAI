/**
 * Propagation: an impact finding becomes a proposal.
 *
 * The proposal goes through exactly the same workflow as any other AI edit -
 * reviewed as a diff, accepted or rejected by the author, applied server-side
 * with a ledger entry. Nothing about being machine-identified gives it a
 * shortcut into the document.
 *
 * What is different is the trail it leaves: the proposal records the finding it
 * resolves, and the resulting ledger entry is marked `propagation` rather than
 * `ai_accepted`, so a reader can follow it back to the change that caused it.
 */

import { buildAskContext } from '@/ai/context-builder';
import { complete } from '@/ai/gateway';
import { buildModifyMessages, conversationTitle, parseModifyResponse } from '@/ai/prompts';
import {
  PROPAGATION_SYSTEM,
  propagationContext,
  propagationInstruction,
} from '@/ai/propagation-prompt';
import { clusterChanges } from '@/core/cluster';
import { traceProvenance } from '@/core/provenance';
import type { ChangeProvenance, SuggestionRecord } from '@/core/types';
import { getStore } from '@/store';

import { briefsFor } from './briefs';
import { asContextDecisions, decisionsForBlock } from './decisions';

export class ImpactNotActionableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpactNotActionableError';
  }
}

export interface PropagationResult {
  suggestion: SuggestionRecord;
  impact: Awaited<ReturnType<ReturnType<typeof getStore>['setImpactStatus']>>;
}

/**
 * Draft an edit that resolves one finding.
 *
 * The model is given the passage, its surroundings, the change that caused the
 * problem and the explanation of why this passage is affected - and is told to
 * make the smallest edit that resolves it, not the best paragraph it can write.
 */
export async function propagateImpact(
  documentId: string,
  impactId: string,
): Promise<PropagationResult> {
  const store = getStore();

  const loaded = await store.getDocument(documentId);
  if (!loaded) throw new ImpactNotActionableError(`Document ${documentId} not found`);

  const impacts = await store.listImpacts(documentId);
  const impact = impacts.find((entry) => entry.id === impactId);
  if (!impact) throw new ImpactNotActionableError(`Impact ${impactId} not found`);

  if (impact.suggestionId) {
    throw new ImpactNotActionableError(
      'A proposal already exists for this finding. Review it, or reject it before asking for another.',
    );
  }

  // The passage may have moved on since the analysis ran.
  const { content, document } = loaded;
  const blocks = (await store.listNodes(documentId)).filter(
    (node) => node.id === impact.targetBlockId,
  );
  const current = blocks[0];
  if (!current) {
    throw new ImpactNotActionableError(
      'The passage this finding concerns no longer exists in the document.',
    );
  }

  // The originating changes, so the model knows what it is reconciling with.
  const ledger = await store.listChanges(documentId, { limit: 1000 });
  const originChanges = ledger.filter((change) => impact.sourceChangeIds.includes(change.id));
  const clusters = clusterChanges(originChanges, { includeTrivial: true });

  const instruction = propagationInstruction(impact);

  const built = buildAskContext({
    document,
    content,
    blockId: impact.targetBlockId,
    question: instruction,
    recentChanges: ledger,
    briefs: await briefsFor(documentId, content, impact.targetBlockId),
    decisions: asContextDecisions(
      await decisionsForBlock(documentId, content, impact.targetBlockId),
    ),
    resendSurroundings: true,
  });

  const parts = [
    ...built.parts,
    {
      label: 'The change this must reconcile with',
      text: propagationContext({
        impact,
        clusters,
        originChangeSummaries: originChanges.map((change) => ({
          before: change.before,
          after: change.after,
        })),
      }),
      tokens: 0,
    },
  ];

  const completion = await complete({
    system: PROPAGATION_SYSTEM,
    messages: buildModifyMessages({ parts, instruction }),
    tier: 'reasoning',
    maxTokens: 2000,
  });

  const proposal = parseModifyResponse(completion.text);

  const conversation = await store.createConversation(documentId, {
    anchorBlockId: impact.targetBlockId,
    selection: null,
    selectionText: current.text,
    title: conversationTitle(`Propagation: ${impact.explanation}`),
    relatedImpactId: impact.id,
  });

  const suggestion = await store.createSuggestion(documentId, {
    blockId: impact.targetBlockId,
    conversationId: conversation.id,
    instruction,
    // Measured against the passage as it stands now, not as it stood when the
    // analysis ran - acceptance checks this, and a stale proposal is refused.
    before: current.text,
    proposed: proposal.proposed,
    rationale: proposal.rationale,
    selectionStart: null,
    selectionEnd: null,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    contextDigest: built.digest,
    parentSuggestionId: null,
    sourceImpactId: impact.id,
    baseRevision: document.currentRevision,
  });

  const updated = await store.setImpactStatus(documentId, impactId, {
    status: 'generate_suggestion',
    resolvedBy: 'usr_local',
    suggestionId: suggestion.id,
  });

  return { suggestion, impact: updated };
}

/**
 * Walk a change back to its origin.
 *
 * The fetching lives here; the walk itself is `traceProvenance` in core, so the
 * part with logic in it is testable without a store.
 */
export async function traceChange(
  documentId: string,
  changeId: string,
): Promise<ChangeProvenance | null> {
  const store = getStore();

  const [changes, suggestions, impacts, analyses] = await Promise.all([
    store.listChanges(documentId, { limit: 2000 }),
    store.listSuggestions(documentId),
    store.listImpacts(documentId),
    store.listImpactAnalyses(documentId),
  ]);

  return traceProvenance({ changeId, changes, suggestions, impacts, analyses });
}
