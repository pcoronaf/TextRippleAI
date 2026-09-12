/** Vector helpers for semantic retrieval. */

/**
 * Cosine similarity in [-1, 1].
 *
 * Vectors of different lengths cannot be compared - that means two different
 * embedding models are in play, and returning a number for it would quietly
 * produce nonsense rankings.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/** Unit-length copy of a vector, so similarity is a plain dot product later. */
export function normalise(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? [...vector] : vector.map((value) => value / magnitude);
}
