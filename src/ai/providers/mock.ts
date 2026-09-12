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
    return {
      text: `[mock ${request.tier ?? 'fast'}] ${last.slice(0, 280)}`,
      provider: this.name,
      model: this.models[request.tier ?? 'fast'],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
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
