/**
 * Impact analysis.
 *
 * The spec's pipeline, in order:
 *
 *   pending changes → normalise → filter trivial → cluster → extract concepts
 *   → retrieve candidates → rank → reasoning model → briefing
 *
 * The point of everything before the model is reduction. Reasoning over a whole
 * manuscript for every edit would be unaffordable and worse: retrieval that
 * puts forty plausible passages in front of the model produces a better and
 * cheaper answer than one that puts four hundred.
 *
 * Nothing here writes document content. Turning a finding into a proposal is
 * M6, and it goes through the suggestion workflow like every other AI edit.
 */

import { complete, embed } from '@/ai/gateway';
import {
  IMPACT_SYSTEM,
  buildImpactMessage,
  parseImpactReply,
  UnreadableImpactReplyError,
} from '@/ai/impact-prompt';
import { clusterChanges, type ChangeCluster } from '@/core/cluster';
import { isTrivial } from '@/core/classify';
import { enclosingHeadings, flattenBlocks } from '@/core/document';
import type {
  ChangeRecord,
  DocumentContent,
  ImpactAnalysisRecord,
  ImpactCandidate,
  ImpactRecord,
} from '@/core/types';
import { getStore } from '@/store';
import type { NewImpact } from '@/store';

export interface AnalyseOptions {
  /** Analyse only what changed after this review boundary. */
  sinceCheckpointId?: string | null;
  /** Extra steer for the reasoning model. */
  instructions?: string;
  /** How many passages reach the model. */
  candidateLimit?: number;
  /** Include typographical noise. Off by default, and rightly so. */
  includeTrivial?: boolean;
}

export interface AnalyseResult {
  analysis: ImpactAnalysisRecord;
  impacts: ImpactRecord[];
  candidates: ImpactCandidate[];
}

export class NothingToAnalyseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NothingToAnalyseError';
  }
}

const DEFAULT_CANDIDATE_LIMIT = 30;
/** Depth drawn from each retrieval arm before ranking. */
const ARM_DEPTH = 40;

/**
 * Weights for the spec's candidate score.
 *
 * Explicit signals outrank similarity on purpose: a passage that still uses the
 * old term, or that defines it, is evidence. A passage that merely sounds alike
 * is a guess.
 */
const WEIGHTS = {
  exactTerm: 3,
  definition: 2.5,
  crossReference: 2,
  citation: 1.5,
  numeric: 1.5,
  lexical: 2,
  semantic: 1.5,
};

const NUMBERS = /\d+(?:[.,]\d+)*\s*%?/g;
const REFERENCE = /\b(?:chapter|section|clause|annex|appendix|figure|table)\s*\d+(?:\.\d+)*/gi;

function rank(value: number | null, depth: number): number {
  return value === null ? 0 : (depth - value + 1) / depth;
}

/**
 * Gather the passages that might depend on a set of changes.
 *
 * The central move: search the document for the terminology the change moved
 * *away from*. Everywhere still saying the old thing is exactly what a
 * terminology sweep leaves behind.
 */
async function retrieveCandidates(
  documentId: string,
  content: DocumentContent,
  clusters: ChangeCluster[],
  limit: number,
): Promise<ImpactCandidate[]> {
  const store = getStore();
  const blocks = flattenBlocks(content);
  const byId = new Map(blocks.map((block) => [block.id, block]));

  // Blocks that were themselves changed are the source, not a consequence.
  const changed = new Set(clusters.flatMap((cluster) => cluster.blockIds));

  const scores = new Map<string, ImpactCandidate>();
  const ensure = (blockId: string): ImpactCandidate | null => {
    if (changed.has(blockId)) return null;
    const block = byId.get(blockId);
    if (!block || !block.text.trim()) return null;

    const existing = scores.get(blockId);
    if (existing) return existing;

    const fresh: ImpactCandidate = {
      blockId,
      text: block.text,
      score: 0,
      signals: {
        exactTerm: false,
        definition: false,
        crossReference: false,
        citation: false,
        numeric: false,
        lexicalRank: null,
        semanticRank: null,
      },
    };
    scores.set(blockId, fresh);
    return fresh;
  };

  const removedTerms = [...new Set(clusters.flatMap((cluster) => cluster.terms.removed))];
  const changedText = clusters.flatMap((cluster) => cluster.afterText).join(' ');

  // --- exact terminology ---------------------------------------------------
  for (const block of blocks) {
    if (changed.has(block.id)) continue;
    const haystack = block.text.toLowerCase();
    if (removedTerms.some((term) => haystack.includes(term))) {
      const entry = ensure(block.id);
      if (entry) {
        entry.signals.exactTerm = true;
        entry.score += WEIGHTS.exactTerm;
      }
    }
  }

  // --- definitions of an affected term -------------------------------------
  const definitions = await store.listSemanticUnits(documentId, { types: ['definition'] });
  for (const unit of definitions) {
    const term = unit.value.toLowerCase();
    if (!removedTerms.some((word) => term.includes(word) || word.includes(term))) continue;
    const entry = ensure(unit.nodeId);
    if (entry) {
      entry.signals.definition = true;
      entry.score += WEIGHTS.definition;
    }
  }

  // --- cross-references pointing at the changed material -------------------
  const enclosing = enclosingHeadings(content);
  const sourceHeadings = new Set(
    clusters
      .flatMap((cluster) => cluster.blockIds)
      .flatMap((blockId) => {
        const parents = enclosing.get(blockId);
        return [parents?.sectionId, parents?.chapterId].filter(Boolean) as string[];
      }),
  );
  const sourceTitles = [...sourceHeadings]
    .map((id) => byId.get(id)?.text.toLowerCase().trim())
    .filter(Boolean) as string[];

  for (const block of blocks) {
    if (changed.has(block.id)) continue;
    const references = block.text.match(REFERENCE) ?? [];
    if (references.length === 0) continue;

    const lowered = block.text.toLowerCase();
    const pointsAtSource = sourceTitles.some((title) => title && lowered.includes(title));
    if (!pointsAtSource) continue;

    const entry = ensure(block.id);
    if (entry) {
      entry.signals.crossReference = true;
      entry.score += WEIGHTS.crossReference;
    }
  }

  // --- shared citations and shared figures ---------------------------------
  const citations = await store.listSemanticUnits(documentId, { types: ['citation'] });
  const sourceCitations = new Set(
    citations
      .filter((unit) => changed.has(unit.nodeId))
      .map((unit) => unit.value.toLowerCase()),
  );
  for (const unit of citations) {
    if (changed.has(unit.nodeId)) continue;
    if (!sourceCitations.has(unit.value.toLowerCase())) continue;
    const entry = ensure(unit.nodeId);
    if (entry) {
      entry.signals.citation = true;
      entry.score += WEIGHTS.citation;
    }
  }

  const sourceNumbers = new Set(changedText.match(NUMBERS)?.map((value) => value.trim()) ?? []);
  if (sourceNumbers.size > 0) {
    for (const block of blocks) {
      if (changed.has(block.id)) continue;
      const found = block.text.match(NUMBERS)?.map((value) => value.trim()) ?? [];
      if (!found.some((value) => sourceNumbers.has(value))) continue;
      const entry = ensure(block.id);
      if (entry) {
        entry.signals.numeric = true;
        entry.score += WEIGHTS.numeric;
      }
    }
  }

  // --- lexical and semantic arms -------------------------------------------
  const query = [...removedTerms, ...clusters.flatMap((cluster) => cluster.terms.added)]
    .slice(0, 24)
    .join(' ');

  if (query.trim()) {
    const lexical = await store.searchText(documentId, query, ARM_DEPTH);
    lexical.forEach((hit, index) => {
      const entry = ensure(hit.nodeId);
      if (!entry) return;
      entry.signals.lexicalRank = index + 1;
      entry.score += WEIGHTS.lexical * rank(index + 1, ARM_DEPTH);
    });
  }

  if (changedText.trim()) {
    const embedded = await embed([changedText.slice(0, 4000)]);
    const vector = embedded.vectors[0];
    if (vector?.length) {
      const semantic = await store.searchVector(documentId, vector, ARM_DEPTH);
      semantic.forEach((hit, index) => {
        const entry = ensure(hit.nodeId);
        if (!entry) return;
        entry.signals.semanticRank = index + 1;
        entry.score += WEIGHTS.semantic * rank(index + 1, ARM_DEPTH);
      });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.blockId.localeCompare(b.blockId))
    .slice(0, limit);
}

/** Run the pipeline and record the briefing. */
export async function analyseImpact(
  documentId: string,
  options: AnalyseOptions = {},
): Promise<AnalyseResult> {
  const store = getStore();
  const loaded = await store.getDocument(documentId);
  if (!loaded) throw new NothingToAnalyseError(`Document ${documentId} not found`);

  const { content, document } = loaded;

  // --- normalise and filter -------------------------------------------------
  const all = await store.listChanges(documentId, {
    sinceCheckpointId: options.sinceCheckpointId ?? undefined,
    limit: 1000,
  });

  const considered = all.filter(
    (change) => options.includeTrivial || !isTrivial(change.classification),
  );
  const filtered = all.length - considered.length;

  if (considered.length === 0) {
    throw new NothingToAnalyseError(
      all.length === 0
        ? 'There are no changes to analyse.'
        : `All ${all.length} change(s) in scope are typographical; nothing to analyse.`,
    );
  }

  // --- cluster --------------------------------------------------------------
  const clusters = clusterChanges(considered, { includeTrivial: options.includeTrivial });

  // --- retrieve and rank ----------------------------------------------------
  const limit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const candidates = await retrieveCandidates(documentId, content, clusters, limit);

  const blocksInDocument = flattenBlocks(content).length;
  const retrieval = {
    blocksInDocument,
    candidatesConsidered: candidates.length,
    reductionPercent:
      blocksInDocument === 0
        ? 0
        : Math.round((1 - candidates.length / blocksInDocument) * 1000) / 10,
  };

  const analysis = await store.createImpactAnalysis(documentId, {
    baseCheckpointId: options.sinceCheckpointId ?? null,
    targetRevision: document.currentRevision,
    clusters: clusters.map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      classification: cluster.classification,
      changeIds: cluster.changeIds,
      blockIds: cluster.blockIds,
      size: cluster.size,
    })),
    retrieval,
    changesAnalysed: considered.length,
    changesFiltered: filtered,
  });

  // Nothing survived retrieval: a real and useful answer, and no reason to
  // spend a reasoning call saying so.
  if (candidates.length === 0) {
    const completed = await store.completeImpactAnalysis(documentId, analysis.id, {
      status: 'completed',
      summary:
        'No passage elsewhere in the document shares terminology, definitions, references, citations or figures with these changes.',
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      impacts: [],
    });
    await store.markChangesAnalysed(documentId, considered.map((change) => change.id));
    return { analysis: completed, impacts: [], candidates };
  }

  // --- reasoning ------------------------------------------------------------
  const briefs = await store.listSummaries(documentId, {
    types: ['document'],
    statuses: ['current'],
  });

  const message = buildImpactMessage({
    documentTitle: document.title,
    documentBrief: briefs[0]?.content,
    clusters,
    candidates,
    instructions: options.instructions,
  });

  try {
    const completion = await complete({
      system: IMPACT_SYSTEM,
      messages: [{ role: 'user', content: message }],
      tier: 'reasoning',
      maxTokens: 4000,
    });

    const parsed = parseImpactReply(completion.text, candidates.length);
    const impacts: NewImpact[] = parsed.impacts.map((impact) => {
      const candidate = candidates[impact.candidate - 1];
      // Attribution: with one cluster it is unambiguous; with several the
      // finding is attributed to all of them rather than guessed at.
      const cluster = clusters.length === 1 ? clusters[0] : undefined;

      return {
        sourceChangeIds: cluster
          ? cluster.changeIds
          : clusters.flatMap((entry) => entry.changeIds),
        sourceClusterId: cluster?.id ?? clusters.map((entry) => entry.id).join(','),
        targetBlockId: candidate.blockId,
        targetText: candidate.text,
        impactType: impact.impactType,
        confidence: impact.confidence,
        severity: impact.severity,
        explanation: impact.explanation,
        recommendedAction: impact.recommendedAction,
      };
    });
    const completed = await store.completeImpactAnalysis(documentId, analysis.id, {
      status: 'completed',
      summary: parsed.summary || 'Analysis complete.',
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      impacts,
    });

    await store.markChangesAnalysed(documentId, considered.map((change) => change.id));

    const stored = await store.getImpactAnalysis(documentId, analysis.id);
    return { analysis: completed, impacts: stored?.impacts ?? [], candidates };
  } catch (error) {
    const detail =
      error instanceof UnreadableImpactReplyError
        ? 'The model did not return a readable analysis.'
        : error instanceof Error
          ? error.message
          : 'Analysis failed';

    const failed = await store.completeImpactAnalysis(documentId, analysis.id, {
      status: 'failed',
      summary: '',
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      error: detail,
      impacts: [],
    });

    // The changes are deliberately left pending: a failed analysis has not
    // examined them, and marking them analysed would hide them from the next
    // attempt.
    return { analysis: failed, impacts: [], candidates };
  }
}

/** Ledger entries that have not yet been through an analysis. */
export function pendingChanges(changes: ChangeRecord[]): ChangeRecord[] {
  return changes.filter((change) => change.impactStatus === 'pending');
}
