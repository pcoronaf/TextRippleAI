/**
 * Whether the semantic half of retrieval can be trusted for this document.
 *
 * Hybrid retrieval fuses a lexical ranking with a vector ranking. The vector
 * ranking is only meaningful when the query vector and the stored vectors come
 * from the same embedding model, and when that model is one that encodes
 * meaning at all.
 *
 * Neither condition is guaranteed. The deterministic stub derives its vectors
 * from a SHA-256 digest, so two paragraphs on the same subject land nowhere
 * near each other and a one-character edit scrambles the vector completely. And
 * an index built with one model cannot be queried with another: the numbers are
 * comparable arithmetically and meaningless semantically.
 *
 * In both cases the failure is silent. Cosine similarity over noise returns
 * confident-looking scores, fusion dutifully blends them with the lexical
 * ranking, and the shortlist that reaches the reasoning model is part rubbish
 * with nothing to indicate it. Fusing noise at a reduced weight is not a fix -
 * it is the same error, quieter. So the arm is dropped, and the caller is told
 * why, so the interface can say so rather than implying a semantic search ran.
 */

import { embed } from '@/ai/gateway';
import { getStore } from '@/store';

export type SemanticArmRefusal =
  | 'empty-query'
  | 'not-indexed'
  | 'stub-vectors'
  | 'model-mismatch';

export type SemanticArm =
  | { usable: true; vector: number[]; model: string }
  | { usable: false; reason: SemanticArmRefusal; detail: string };

/** The stub's provider name. Its vectors are hashes, not embeddings. */
const STUB_PROVIDER = 'mock';

export async function semanticArmFor(documentId: string, text: string): Promise<SemanticArm> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { usable: false, reason: 'empty-query', detail: 'No query text to embed.' };
  }

  const stored = await getStore().embeddingModel(documentId);
  if (!stored) {
    return {
      usable: false,
      reason: 'not-indexed',
      detail: 'This document has no block embeddings yet. Refresh the index to enable semantic retrieval.',
    };
  }

  const embedded = await embed([trimmed]);
  const vector = embedded.vectors[0];
  if (!vector?.length) {
    return { usable: false, reason: 'not-indexed', detail: 'The embedding provider returned nothing.' };
  }

  if (embedded.provider === STUB_PROVIDER || stored.provider === STUB_PROVIDER) {
    return {
      usable: false,
      reason: 'stub-vectors',
      detail:
        'Embeddings are the deterministic stub, whose vectors are derived from a hash and carry no meaning. ' +
        'Ranking is lexical only. Configure an embedding model and rebuild the index for semantic retrieval.',
    };
  }

  if (embedded.model !== stored.model) {
    return {
      usable: false,
      reason: 'model-mismatch',
      detail:
        `The index was built with ${stored.model} but queries are embedded with ${embedded.model}. ` +
        'Vectors from different models are not comparable; rebuild the index to use it.',
    };
  }

  return { usable: true, vector, model: embedded.model };
}
