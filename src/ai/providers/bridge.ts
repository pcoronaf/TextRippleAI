import { promises as fs } from 'node:fs';
import path from 'node:path';

import { credential } from '../credentials';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ModelTier,
  ProviderStatus,
} from '../types';

/**
 * A provider answered by whoever is watching, rather than by an HTTP API.
 *
 * Each request is written to a directory as JSON and the call blocks until a
 * matching answer file appears. Anything that can watch a folder can then act
 * as the model: a person, a script, or an agent with shell access.
 *
 * Two reasons this is worth having beyond the obvious one of running without
 * credits. It makes the exact prompt the product sends inspectable, which is
 * otherwise only visible through the context digest after the fact. And it
 * makes the provider boundary demonstrably complete: if a filesystem can be a
 * provider, nothing above this layer is quietly depending on a vendor.
 *
 * It serves no embeddings, deliberately. A vector is not something a person or
 * a language model can produce by hand, and inventing one would poison
 * retrieval while looking like it worked. The gateway's existing fallback
 * applies: OpenAI's embedding model when a key is present, the deterministic
 * stub otherwise.
 */
export class BridgeProvider implements AiProvider {
  readonly name = 'bridge';

  private get directory(): string {
    return credential('AI_BRIDGE_DIR') ?? path.join(process.env.DATA_DIR ?? '.data', 'bridge');
  }

  /** How long a request waits for an answer before giving up. */
  private get timeoutMs(): number {
    const configured = Number(credential('AI_BRIDGE_TIMEOUT_MS'));
    return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
  }

  private readonly models: Record<ModelTier, string> = {
    fast: 'bridge-operator',
    reasoning: 'bridge-operator',
  };

  status(): ProviderStatus {
    return {
      provider: this.name,
      configured: true,
      models: this.models,
      embeddingModel: null,
      detail: `Requests are written to ${this.directory} and wait for an answer`,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const root = this.directory;
    const pending = path.join(root, 'pending');
    const answered = path.join(root, 'answered');
    await fs.mkdir(pending, { recursive: true });
    await fs.mkdir(answered, { recursive: true });

    const id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const requestFile = path.join(pending, `${id}.json`);
    const answerFile = path.join(answered, `${id}.json`);

    await fs.writeFile(
      requestFile,
      JSON.stringify(
        {
          id,
          tier: request.tier ?? 'fast',
          maxTokens: request.maxTokens ?? null,
          system: request.system ?? null,
          messages: request.messages,
          // So a watcher knows where to put the answer without inferring it.
          answerTo: answerFile,
          doneMarker: `${answerFile}.done`,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const answer = await readAnswer(answerFile);
      if (answer !== null) {
        // Keep the pair out of the way so a later pass does not re-read it.
        await fs.rm(requestFile, { force: true }).catch(() => undefined);
        return {
          text: answer,
          provider: this.name,
          model: this.models[request.tier ?? 'fast'],
          // Nothing was billed, and reporting a guess would corrupt the running
          // total the status bar shows.
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await fs.rm(requestFile, { force: true }).catch(() => undefined);
    throw new Error(
      `No answer for ${id} within ${Math.round(this.timeoutMs / 1000)}s. ` +
        `Write the reply to ${answerFile}, then touch ${answerFile}.done.`,
    );
  }
}

/**
 * Read an answer, but only once it is complete.
 *
 * A watcher writing a file is not atomic, so polling the answer directly would
 * eventually read half of one. The convention is therefore two files: the
 * answer itself, then an empty `.done` beside it. Only the marker is polled,
 * so the answer can be any format - the impact reply is JSON, and requiring
 * the watcher to wrap its JSON in more JSON would be a trap.
 */
async function readAnswer(file: string): Promise<string | null> {
  try {
    await fs.access(`${file}.done`);
  } catch {
    return null;
  }

  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}
