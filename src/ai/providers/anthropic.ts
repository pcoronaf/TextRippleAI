import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ModelTier,
  ProviderStatus,
} from '../types';

/**
 * Anthropic adapter.
 *
 * Anthropic serves no embedding model, so semantic indexing (M4) falls back to
 * the OpenAI embedding model when one is configured - see `gateway.ts`.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  private readonly models: Record<ModelTier, string> = {
    fast: process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5',
    reasoning: process.env.ANTHROPIC_REASONING_MODEL ?? 'claude-opus-5',
  };

  status(): ProviderStatus {
    const configured = Boolean(process.env.ANTHROPIC_API_KEY);
    return {
      provider: this.name,
      configured,
      models: this.models,
      embeddingModel: null,
      detail: configured ? undefined : 'ANTHROPIC_API_KEY is not set',
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const model = this.models[request.tier ?? 'fast'];

    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens ?? 4096,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    // `content` is a discriminated union; only text blocks carry prose.
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      provider: this.name,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
