import { sha256Hex } from '@/core/hash';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ModelTier,
  ProviderStatus,
} from '../types';

/**
 * Deterministic stand-in provider.
 *
 * It lets the whole context-building and prompt path be exercised - in tests
 * and in local development - without an API key and without spending tokens.
 */
export class MockProvider implements AiProvider {
  readonly name = 'mock';

  private readonly models: Record<ModelTier, string> = {
    fast: 'mock-fast',
    reasoning: 'mock-reasoning',
  };

  status(): ProviderStatus {
    return {
      provider: this.name,
      configured: true,
      models: this.models,
      embeddingModel: 'mock-embedding-64',
      detail: 'Deterministic stub - no external calls, no tokens spent',
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const last = request.messages[request.messages.length - 1]?.content ?? '';

    // When the caller's contract asks for a particular shape, answer in it.
    // That keeps the propose/review/accept and analyse paths exercisable
    // without an API key, which is the point of having a stub at all.
    const text = request.system?.includes('<replacement>')
      ? this.proposal(last)
      : request.system?.includes('"impacts"')
        ? this.impactReply(last)
        : `[mock ${request.tier ?? 'fast'}] ${last.slice(0, 280)}`;

    return {
      text,
      provider: this.name,
      model: this.models[request.tier ?? 'fast'],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  /**
   * Flag the first two candidate passages, in the documented JSON shape.
   *
   * Deterministic rather than plausible: the point is to exercise the parsing,
   * persistence and review path, not to imitate judgement.
   */
  private impactReply(message: string): string {
    const candidates = [...message.matchAll(/### Candidate (\d+) - (\S+)/g)];

    return JSON.stringify({
      summary: `Deterministic stub: ${candidates.length} candidate passage(s) were considered.`,
      impacts: candidates.slice(0, 2).map(([, number], index) => ({
        candidate: Number(number),
        impact_type: index === 0 ? 'terminology_consistency' : 'cross_reference',
        severity: index === 0 ? 'high' : 'low',
        confidence: index === 0 ? 0.9 : 0.4,
        explanation: `Stub finding for candidate ${number}.`,
        recommended_action: index === 0 ? 'revise' : 'review',
      })),
    });
  }

  /** Echo the passage back with a visible marker, in the documented format. */
  private proposal(message: string): string {
    const selected = /## Selected text\n([\s\S]*?)(?:\n\n## |$)/.exec(message);
    const passage = (selected?.[1] ?? 'The passage.').trim();

    return [
      '<replacement>',
      `${passage} (revised by the mock provider)`,
      '</replacement>',
      '<rationale>',
      'Deterministic stub: the passage is echoed back with a marker so the review workflow can be exercised.',
      '</rationale>',
    ].join('\n');
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    // Hash-derived pseudo-vectors: stable for identical text, so retrieval
    // plumbing can be tested end to end.
    const vectors = texts.map((text) => {
      const digest = sha256Hex(text);
      const vector: number[] = [];
      for (let i = 0; i < 64; i++) {
        const byte = parseInt(digest.slice((i % 32) * 2, (i % 32) * 2 + 2), 16);
        vector.push((byte - 127.5) / 127.5);
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });

    return { vectors, provider: this.name, model: 'mock-embedding-64' };
  }
}
