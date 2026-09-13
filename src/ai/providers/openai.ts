import { credential } from '../credentials';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ModelTier,
  ProviderStatus,
} from '../types';

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  // Read per call rather than captured at construction: the key and the models
  // can be changed from the settings panel while the server is running.
  private get models(): Record<ModelTier, string> {
    return {
      fast: credential('OPENAI_FAST_MODEL') ?? 'gpt-4.1-mini',
      reasoning: credential('OPENAI_REASONING_MODEL') ?? 'gpt-4.1',
    };
  }

  private get embeddingModel(): string {
    return credential('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
  }

  status(): ProviderStatus {
    const configured = Boolean(credential('OPENAI_API_KEY'));
    return {
      provider: this.name,
      configured,
      models: this.models,
      embeddingModel: this.embeddingModel,
      detail: configured ? undefined : 'OPENAI_API_KEY is not set',
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: credential('OPENAI_API_KEY') });
    const model = this.models[request.tier ?? 'fast'];

    const response = await client.chat.completions.create({
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages: [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    });

    return {
      text: response.choices[0]?.message?.content ?? '',
      provider: this.name,
      model: response.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: credential('OPENAI_API_KEY') });

    const response = await client.embeddings.create({
      model: this.embeddingModel,
      input: texts,
    });

    return {
      vectors: response.data.map((item) => item.embedding),
      provider: this.name,
      model: response.model,
    };
  }
}
