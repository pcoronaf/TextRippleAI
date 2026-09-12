/**
 * Hybrid retrieval.
 *
 * Semantic similarity alone is not enough: a search for "human oversight"
 * should put the paragraph that uses those exact words above one that merely
 * discusses adjacent ideas, and a search for a concept should still find the
 * paragraph that expresses it in different words. So the two are run
 * separately and fused.
 *
 * Fusion is reciprocal rank, weighted. It needs no score normalisation between
 * two rankers whose scores are not comparable, degrades gracefully when one
 * ranker returns nothing, and has one tunable constant rather than a scoring
 * formula per signal.
 */

import { embed } from '@/ai/gateway';
import type { RetrievalHit } from '@/core/types';
import { getStore } from '@/store';

export type RetrievalMode = 'hybrid' | 'text' | 'semantic';

export interface SearchOptions {
  mode?: RetrievalMode;
  limit?: number;
}

/** Reciprocal-rank constant. 60 is the value the RRF literature settles on. */
const RRF_K = 60;

const WEIGHTS = {
  lexical: 1,
  semantic: 1,
  /** A block that literally contains the query phrase. */
  exactPhrase: 0.5,
  /** A block that defines a term in the query. */
  definition: 0.75,
};

/** How many candidates each ranker contributes before fusion. */
const CANDIDATE_DEPTH = 40;

export interface SearchResult {
  hits: RetrievalHit[];
  mode: RetrievalMode;
  /** Whether the semantic half actually ran. */
  semanticAvailable: boolean;
}

export async function search(
  documentId: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const store = getStore();
  const mode = options.mode ?? 'hybrid';
  const limit = options.limit ?? 10;
  const trimmed = query.trim();

  if (!trimmed) return { hits: [], mode, semanticAvailable: false };

  const wantsText = mode === 'hybrid' || mode === 'text';
  const wantsSemantic = mode === 'hybrid' || mode === 'semantic';

  const lexical = wantsText ? await store.searchText(documentId, trimmed, CANDIDATE_DEPTH) : [];

  let semantic: Awaited<ReturnType<typeof store.searchVector>> = [];
  let semanticAvailable = false;

  if (wantsSemantic) {
    const embedded = await embed([trimmed]);
    const vector = embedded.vectors[0];
    if (vector?.length) {
      semantic = await store.searchVector(documentId, vector, CANDIDATE_DEPTH);
      semanticAvailable = semantic.length > 0;
    }
  }

  // Definitions are a strong structural signal: a paragraph that defines a term
  // the query mentions is about that term, whatever the similarity says.
  const definitions = await store.listSemanticUnits(documentId, { types: ['definition'] });
  const lowered = trimmed.toLowerCase();
  const definingNodes = new Set(
    definitions
      .filter((unit) => lowered.includes(unit.value.toLowerCase()))
      .map((unit) => unit.nodeId),
  );

  const merged = new Map<string, RetrievalHit>();

  const ensure = (nodeId: string, text: string): RetrievalHit => {
    const existing = merged.get(nodeId);
    if (existing) return existing;

    const fresh: RetrievalHit = {
      nodeId,
      text,
      score: 0,
      signals: {
        lexicalRank: null,
        semanticRank: null,
        semanticSimilarity: null,
        exactTerm: text.toLowerCase().includes(lowered),
        definition: definingNodes.has(nodeId),
      },
    };
    merged.set(nodeId, fresh);
    return fresh;
  };

  lexical.forEach((hit, index) => {
    const entry = ensure(hit.nodeId, hit.text);
    entry.signals.lexicalRank = index + 1;
    entry.score += WEIGHTS.lexical / (RRF_K + index + 1);
  });

  semantic.forEach((hit, index) => {
    const entry = ensure(hit.nodeId, hit.text);
    entry.signals.semanticRank = index + 1;
    entry.signals.semanticSimilarity = hit.similarity;
    entry.score += WEIGHTS.semantic / (RRF_K + index + 1);
  });

  for (const hit of merged.values()) {
    if (hit.signals.exactTerm) hit.score += WEIGHTS.exactPhrase / RRF_K;
    if (hit.signals.definition) hit.score += WEIGHTS.definition / RRF_K;
  }

  const hits = [...merged.values()]
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
    .slice(0, limit);

  return { hits, mode, semanticAvailable };
}
