/**
 * AI gateway boundary.
 *
 * The product must stay provider-independent, so nothing above this layer
 * knows which model answered. Routing is by tier, not by model name.
 */

/** Fast/cheap work versus work that needs a reasoning model. */
export type ModelTier = 'fast' | 'reasoning';

export interface CompletionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system?: string;
  messages: CompletionMessage[];
  tier?: ModelTier;
  maxTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  usage: TokenUsage;
}

export interface EmbeddingResult {
  vectors: number[][];
  provider: string;
  model: string;
}

export interface ProviderStatus {
  provider: string;
  configured: boolean;
  models: Record<ModelTier, string>;
  embeddingModel: string | null;
  /** Why the provider is unusable, when it is. */
  detail?: string;
}

export interface AiProvider {
  readonly name: string;
  /** Reported without contacting the provider - describing costs nothing. */
  status(): ProviderStatus;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  embed?(texts: string[]): Promise<EmbeddingResult>;
}
