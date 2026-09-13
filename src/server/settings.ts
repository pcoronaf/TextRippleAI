/**
 * Stored AI settings.
 *
 * The gateway reads its configuration from the environment first and from here
 * second (see `src/ai/credentials.ts`). This exists for one reason: the
 * packaged desktop build has no shell to export `ANTHROPIC_API_KEY` in, so
 * without somewhere to put a key the whole AI half of the product is
 * unreachable for anyone who does not run it from a terminal.
 *
 * The file sits beside the documents in `DATA_DIR`. It holds an API key in
 * plain text, which is worth being explicit about rather than dressing up: the
 * only alternatives are an OS keychain (a native dependency, and the packaged
 * build is deliberately pure JavaScript) or a password the user would have to
 * type on every launch. The file is written owner-only where the platform
 * honours that, and is the same trust level as the documents next to it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { setCredentialSource } from '@/ai/credentials';

export type StoredProvider = 'anthropic' | 'openai' | 'mock';

export interface StoredSettings {
  provider?: StoredProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

/** Settings key for each environment variable the gateway looks up. */
const BY_ENV_NAME: Record<string, keyof StoredSettings> = {
  AI_PROVIDER: 'provider',
  ANTHROPIC_API_KEY: 'anthropicApiKey',
  OPENAI_API_KEY: 'openaiApiKey',
};

/** Where the settings file lives - alongside the documents. */
export function settingsPath(): string {
  return path.join(process.env.DATA_DIR ?? '.data', 'settings.json');
}

let cached: { mtimeMs: number; settings: StoredSettings } | null = null;

/**
 * Read the settings file.
 *
 * Cached against the file's modification time, because the credential lookup
 * runs on every provider call and re-parsing per call would be silly. A
 * malformed file is treated as absent rather than thrown from: a corrupt
 * settings file should not take the editor down with it.
 */
export function readSettings(): StoredSettings {
  const file = settingsPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cached = null;
    return {};
  }

  if (cached && cached.mtimeMs === mtimeMs) return cached.settings;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSettings;
    const settings = parsed && typeof parsed === 'object' ? parsed : {};
    cached = { mtimeMs, settings };
    return settings;
  } catch {
    cached = { mtimeMs, settings: {} };
    return {};
  }
}

/**
 * Merge a patch into the settings file.
 *
 * `null` clears a field; an omitted field is left alone. Returns what is now
 * stored - never echoed back over HTTP, but useful to the caller.
 */
export interface SettingsPatch {
  provider?: StoredProvider | null;
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
}

export function writeSettings(patch: SettingsPatch): StoredSettings {
  const current = { ...readSettings() };

  function apply<K extends keyof StoredSettings>(key: K, value: StoredSettings[K] | null | undefined): void {
    if (value === undefined) return;
    const trimmed = value === null ? '' : value.trim();
    if (trimmed === '') delete current[key];
    else current[key] = trimmed as StoredSettings[K];
  }

  apply('provider', patch.provider);
  apply('anthropicApiKey', patch.anthropicApiKey);
  apply('openaiApiKey', patch.openaiApiKey);

  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  cached = null;
  return current;
}

/**
 * Point the AI layer's credential lookup at this file.
 *
 * Called from `src/server/http.ts`, which every API route already imports, so
 * that the source is installed wherever a request can reach the gateway
 * without each route having to remember.
 */
export function installCredentialSource(): void {
  setCredentialSource((name) => {
    const field = BY_ENV_NAME[name];
    if (!field) return undefined;
    const value = readSettings()[field];
    return typeof value === 'string' ? value : undefined;
  });
}

/** Writes are refused when the deployment says settings are managed elsewhere. */
export function settingsAreWritable(): boolean {
  return process.env.SETTINGS_READONLY !== '1';
}

/** Forget the cached file. Used by tests, which move DATA_DIR around. */
export function clearSettingsCache(): void {
  cached = null;
}
