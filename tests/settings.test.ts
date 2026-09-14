import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credential, credentialOrigin, resetCredentialSource } from '@/ai/credentials';
import { gatewayStatus } from '@/ai/gateway';
import {
  clearSettingsCache,
  installCredentialSource,
  readSettings,
  settingsAreWritable,
  settingsPath,
  writeSettings,
} from '@/server/settings';

const root = mkdtempSync(path.join(tmpdir(), 'textripple-settings-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV_KEYS = [
  'DATA_DIR',
  'AI_PROVIDER',
  'AI_EMBEDDING_PROVIDER',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'SETTINGS_READONLY',
];
let saved: Record<string, string | undefined>;
let counter = 0;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];

  process.env.DATA_DIR = path.join(root, `run-${counter++}`);
  clearSettingsCache();
  installCredentialSource();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearSettingsCache();
  resetCredentialSource();
});

describe('stored settings', () => {
  it('reads back nothing when no file exists', () => {
    expect(readSettings()).toEqual({});
    expect(credential('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(credentialOrigin('ANTHROPIC_API_KEY')).toBe('none');
  });

  it('makes a stored key reachable to the AI layer', () => {
    writeSettings({ provider: 'anthropic', anthropicApiKey: 'sk-ant-stored' });

    expect(credential('ANTHROPIC_API_KEY')).toBe('sk-ant-stored');
    expect(credentialOrigin('ANTHROPIC_API_KEY')).toBe('settings');
    expect(gatewayStatus().selected).toBe('anthropic');
  });

  it('lets the environment win over the file', () => {
    // A deployment configured by environment variable must not be silently
    // repointed by whatever is on disk - and CI must stay on the mock.
    writeSettings({ provider: 'anthropic', anthropicApiKey: 'sk-ant-stored' });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    process.env.AI_PROVIDER = 'openai';

    expect(credential('ANTHROPIC_API_KEY')).toBe('sk-ant-from-env');
    expect(credentialOrigin('ANTHROPIC_API_KEY')).toBe('environment');
    expect(gatewayStatus().selected).toBe('openai');
    // The stored value is still there, just shadowed.
    expect(readSettings().anthropicApiKey).toBe('sk-ant-stored');
  });

  it('treats an empty environment variable as unset', () => {
    writeSettings({ anthropicApiKey: 'sk-ant-stored' });
    process.env.ANTHROPIC_API_KEY = '   ';

    expect(credential('ANTHROPIC_API_KEY')).toBe('sk-ant-stored');
    expect(credentialOrigin('ANTHROPIC_API_KEY')).toBe('settings');
  });

  it('merges a patch rather than replacing the file', () => {
    writeSettings({ provider: 'anthropic', anthropicApiKey: 'sk-ant', openaiApiKey: 'sk-openai' });
    writeSettings({ provider: 'openai' });

    expect(readSettings()).toEqual({
      provider: 'openai',
      anthropicApiKey: 'sk-ant',
      openaiApiKey: 'sk-openai',
    });
  });

  it('clears a field with null and leaves an omitted one alone', () => {
    writeSettings({ provider: 'anthropic', anthropicApiKey: 'sk-ant', openaiApiKey: 'sk-openai' });
    writeSettings({ anthropicApiKey: null });

    const stored = readSettings();
    expect(stored.anthropicApiKey).toBeUndefined();
    expect(stored.openaiApiKey).toBe('sk-openai');
    expect(stored.provider).toBe('anthropic');
  });

  it('treats a blank key as clearing it', () => {
    writeSettings({ anthropicApiKey: 'sk-ant' });
    writeSettings({ anthropicApiKey: '   ' });

    expect(readSettings().anthropicApiKey).toBeUndefined();
  });

  it('trims a pasted key', () => {
    // Copying a key out of a dashboard routinely brings whitespace with it.
    writeSettings({ anthropicApiKey: '  sk-ant-padded\n' });
    expect(readSettings().anthropicApiKey).toBe('sk-ant-padded');
  });

  it('picks up a file edited outside the process', () => {
    writeSettings({ anthropicApiKey: 'sk-first' });
    expect(credential('ANTHROPIC_API_KEY')).toBe('sk-first');

    // The cache is keyed on the modification time. Setting it explicitly tests
    // the invalidation rather than the resolution of the filesystem clock.
    const file = settingsPath();
    writeFileSync(file, JSON.stringify({ anthropicApiKey: 'sk-second' }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);

    expect(credential('ANTHROPIC_API_KEY')).toBe('sk-second');
  });

  it('survives a corrupt file instead of taking the app down', () => {
    writeSettings({ anthropicApiKey: 'sk-ant' });
    writeFileSync(settingsPath(), '{ this is not json');

    clearSettingsCache();
    expect(readSettings()).toEqual({});
    expect(() => gatewayStatus()).not.toThrow();
  });

  it('stores the file beside the documents', () => {
    writeSettings({ anthropicApiKey: 'sk-ant' });

    expect(settingsPath()).toBe(path.join(process.env.DATA_DIR!, 'settings.json'));
    expect(existsSync(settingsPath())).toBe(true);
    expect(readFileSync(settingsPath(), 'utf8')).toContain('sk-ant');
  });

  it('can be made read-only for a deployment that configures keys elsewhere', () => {
    expect(settingsAreWritable()).toBe(true);
    process.env.SETTINGS_READONLY = '1';
    expect(settingsAreWritable()).toBe(false);
  });

  it('reports where each value came from', () => {
    writeSettings({ anthropicApiKey: 'sk-ant-stored' });
    process.env.OPENAI_API_KEY = 'sk-openai-env';

    const { origins } = gatewayStatus();
    expect(origins.anthropicApiKey).toBe('settings');
    expect(origins.openaiApiKey).toBe('environment');
    expect(origins.provider).toBe('none');
  });
});

describe('pinning where embeddings come from', () => {
  it('follows the selected provider by default', () => {
    writeSettings({ provider: 'openai', openaiApiKey: 'sk-openai' });
    expect(gatewayStatus().embeddings).toBe('openai');
  });

  it('falls back to the stub when nothing can serve them', () => {
    writeSettings({ provider: 'bridge' });
    expect(gatewayStatus().embeddings).toBe('mock');
  });

  it('borrows OpenAI when the selected provider serves none but a key exists', () => {
    writeSettings({ provider: 'bridge', openaiApiKey: 'sk-openai' });
    expect(gatewayStatus().embeddings).toBe('openai');
  });

  it('can be pinned to the stub even with a key stored', () => {
    // The case this exists for: a key that authenticates but has no credit, or
    // an index already built with different vectors.
    writeSettings({ provider: 'bridge', openaiApiKey: 'sk-openai', embeddingProvider: 'mock' });
    expect(gatewayStatus().embeddings).toBe('mock');
  });

  it('can be pinned to OpenAI regardless of the selected provider', () => {
    writeSettings({ provider: 'anthropic', embeddingProvider: 'openai' });
    expect(gatewayStatus().embeddings).toBe('openai');
  });

  it('is overridden by the environment like everything else', () => {
    writeSettings({ provider: 'bridge', openaiApiKey: 'sk-openai', embeddingProvider: 'mock' });
    process.env.AI_EMBEDDING_PROVIDER = 'openai';
    expect(gatewayStatus().embeddings).toBe('openai');
  });
});
