/**
 * AI gateway.
 *
 * Routes work to a provider by tier. Nothing in M0-M1 calls it: normal editing
 * consumes zero tokens by design, and it exists now so that M2 (chat with
 * selection) plugs a Context Builder into a settled boundary rather than a new
 * one.
 */

import { AnthropicProvider } from './providers/anthropic';
import { MockProvider } from './providers/mock';
import { OpenAiProvider } from './providers/openai';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ProviderStatus,
} from './types';

export * from './types';

export type ProviderName = 'anthropic' | 'openai' | 'mock';

function providerName(): ProviderName {
  const configured = (process.env.AI_PROVIDER ?? 'mock').toLowerCase();
  if (configured === 'anthropic' || configured === 'openai') return configured;
  return 'mock';
}

function createProvider(name: ProviderName): AiProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAiProvider();
    default:
      return new MockProvider();
  }
}

export function getProvider(name: ProviderName = providerName()): AiProvider {
  return createProvider(name);
}

export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  return getProvider().complete(request);
}

/**
 * Embeddings for semantic retrieval.
 *
 * The selected provider is used when it serves embeddings. Anthropic does not,
 * so an Anthropic deployment borrows OpenAI's embedding model when a key is
 * present, and otherwise falls back to the deterministic stub.
 */
export async function embed(texts: string[]): Promise<EmbeddingResult> {
  const primary = getProvider();
  if (primary.embed) return primary.embed(texts);

  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAiProvider();
    return openai.embed(texts);
  }

  return new MockProvider().embed(texts);
}

/** Configuration report. Makes no network call, so it costs nothing. */
export function gatewayStatus(): {
  selected: ProviderName;
  providers: ProviderStatus[];
} {
  return {
    selected: providerName(),
    providers: [new AnthropicProvider(), new OpenAiProvider(), new MockProvider()].map((provider) =>
      provider.status(),
    ),
  };
}
