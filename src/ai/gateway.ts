/**
 * AI gateway.
 *
 * Routes work to a provider by tier. Nothing in M0-M1 calls it: normal editing
 * consumes zero tokens by design, and it exists now so that M2 (chat with
 * selection) plugs a Context Builder into a settled boundary rather than a new
 * one.
 */

import { credential, credentialOrigin, type CredentialOrigin } from './credentials';
import { AnthropicProvider } from './providers/anthropic';
import { BridgeProvider } from './providers/bridge';
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

export type ProviderName = 'anthropic' | 'openai' | 'bridge' | 'mock';

function providerName(): ProviderName {
  const configured = (credential('AI_PROVIDER') ?? 'mock').toLowerCase();
  if (configured === 'anthropic' || configured === 'openai' || configured === 'bridge') {
    return configured;
  }
  return 'mock';
}

function createProvider(name: ProviderName): AiProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAiProvider();
    case 'bridge':
      return new BridgeProvider();
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

  if (credential('OPENAI_API_KEY')) {
    const openai = new OpenAiProvider();
    return openai.embed(texts);
  }

  return new MockProvider().embed(texts);
}

/** Configuration report. Makes no network call, so it costs nothing. */
export function gatewayStatus(): {
  selected: ProviderName;
  /** Where the selection and each key came from, so the UI can explain itself. */
  origins: { provider: CredentialOrigin; anthropicApiKey: CredentialOrigin; openaiApiKey: CredentialOrigin };
  providers: ProviderStatus[];
} {
  return {
    selected: providerName(),
    origins: {
      provider: credentialOrigin('AI_PROVIDER'),
      anthropicApiKey: credentialOrigin('ANTHROPIC_API_KEY'),
      openaiApiKey: credentialOrigin('OPENAI_API_KEY'),
    },
    providers: [
      new AnthropicProvider(),
      new OpenAiProvider(),
      new BridgeProvider(),
      new MockProvider(),
    ].map((provider) =>
      provider.status(),
    ),
  };
}
