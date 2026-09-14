import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetCredentialSource, setCredentialSource } from '@/ai/credentials';
import { BridgeProvider } from '@/ai/providers/bridge';
import { getProvider } from '@/ai/gateway';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-bridge-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir: string;
let counter = 0;

beforeEach(() => {
  dir = path.join(root, `run-${counter++}`);
  setCredentialSource((name) => {
    if (name === 'AI_BRIDGE_DIR') return dir;
    if (name === 'AI_BRIDGE_TIMEOUT_MS') return '4000';
    return undefined;
  });
});

afterEach(() => resetCredentialSource());

/** Answer the single pending request once it appears. */
async function answerWith(text: string): Promise<Record<string, unknown>> {
  const pending = path.join(dir, 'pending');
  for (let attempt = 0; attempt < 80; attempt++) {
    let files: string[] = [];
    try {
      files = readdirSync(pending).filter((name) => name.endsWith('.json'));
    } catch {
      files = [];
    }
    if (files.length > 0) {
      const request = JSON.parse(readFileSync(path.join(pending, files[0]), 'utf8'));
      writeFileSync(request.answerTo, text, 'utf8');
      writeFileSync(request.doneMarker, '', 'utf8');
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no request appeared');
}

describe('the bridge provider', () => {
  it('writes the request out and returns what is written back', async () => {
    const provider = new BridgeProvider();
    const answering = answerWith('{"summary":"done","impacts":[]}');
    const completion = await provider.complete({
      system: 'You analyse documents.',
      messages: [{ role: 'user', content: 'What changed?' }],
      tier: 'reasoning',
    });

    const request = await answering;
    expect(request.system).toBe('You analyse documents.');
    expect(request.tier).toBe('reasoning');
    expect(completion.text).toBe('{"summary":"done","impacts":[]}');
    expect(completion.provider).toBe('bridge');
  });

  it('reports no tokens, because nothing was billed', async () => {
    const provider = new BridgeProvider();
    const answering = answerWith('anything');
    const completion = await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
    await answering;

    expect(completion.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('waits for the completion marker rather than reading a half-written file', async () => {
    const provider = new BridgeProvider();
    const pending = path.join(dir, 'pending');

    const call = provider.complete({ messages: [{ role: 'user', content: 'hello' }] });

    // Write the answer but withhold the marker; the call must still be waiting.
    let request: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 80 && !request; attempt++) {
      try {
        const [file] = readdirSync(pending).filter((name) => name.endsWith('.json'));
        if (file) request = JSON.parse(readFileSync(path.join(pending, file), 'utf8'));
      } catch {
        // not yet
      }
      if (!request) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    writeFileSync(request!.answerTo as string, 'the complete answer', 'utf8');

    const raced = await Promise.race([
      call.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 600)),
    ]);
    expect(raced).toBe('still waiting');

    writeFileSync(request!.doneMarker as string, '', 'utf8');
    expect((await call).text).toBe('the complete answer');
  });

  it('gives up with an actionable message when nobody answers', async () => {
    setCredentialSource((name) =>
      name === 'AI_BRIDGE_DIR' ? dir : name === 'AI_BRIDGE_TIMEOUT_MS' ? '300' : undefined,
    );

    await expect(
      new BridgeProvider().complete({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/Write the reply to/);
  });

  it('serves no embeddings, so retrieval falls back rather than being faked', () => {
    // A vector cannot be produced by hand, and inventing one would look like it
    // worked while poisoning every similarity comparison.
    expect(new BridgeProvider().embed).toBeUndefined();
  });

  it('is reachable through the gateway by name', () => {
    expect(getProvider('bridge').name).toBe('bridge');
  });
});
