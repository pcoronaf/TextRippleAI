'use client';

import { useState } from 'react';

export type CredentialOrigin = 'environment' | 'settings' | 'none';

export interface SettingsReport {
  selected: 'anthropic' | 'openai' | 'mock';
  origins: { provider: CredentialOrigin; anthropicApiKey: CredentialOrigin; openaiApiKey: CredentialOrigin };
  providers: { provider: string; configured: boolean; models: Record<string, string>; detail?: string }[];
  stored: { provider: string | null; anthropicApiKey: boolean; openaiApiKey: boolean };
  writable: boolean;
  file: string;
}

export interface SettingsPanelProps {
  report: SettingsReport | null;
  busy: boolean;
  onSave: (patch: {
    provider?: 'anthropic' | 'openai' | 'mock';
    anthropicApiKey?: string | null;
    openaiApiKey?: string | null;
  }) => Promise<void>;
}

const ORIGIN_NOTE: Record<CredentialOrigin, string> = {
  environment: 'set by an environment variable, which overrides anything stored here',
  settings: 'stored here',
  none: 'not set',
};

/**
 * Where the model is configured.
 *
 * A key entered here is written to a file beside the documents and is never
 * read back into the browser - the panel is told whether one is stored, not
 * what it is.
 */
export function SettingsPanel({ report, busy, onSave }: SettingsPanelProps) {
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  if (!report) return <div className="panel">Loading...</div>;

  const save = async (
    patch: Parameters<SettingsPanelProps['onSave']>[0],
    message: string,
  ): Promise<void> => {
    await onSave(patch);
    setSaved(message);
  };

  const keyRow = (
    label: string,
    field: 'anthropicApiKey' | 'openaiApiKey',
    value: string,
    setValue: (next: string) => void,
  ) => {
    const origin = report.origins[field];
    const stored = report.stored[field];
    // A computed key would widen to a string index signature and stop matching
    // the patch type, so build the patch explicitly.
    const patch = (next: string | null) =>
      field === 'anthropicApiKey' ? { anthropicApiKey: next } : { openaiApiKey: next };

    return (
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', marginBottom: 4 }}>
          <strong>{label}</strong>
        </label>
        <div className="field-row">
          <input
            type="password"
            autoComplete="off"
            placeholder={stored ? 'A key is stored. Type to replace it.' : 'Paste a key...'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={!report.writable}
          />
          <button
            onClick={async () => {
              await save(patch(value), `${label} saved.`);
              setValue('');
            }}
            disabled={busy || !report.writable || !value.trim()}
          >
            Save
          </button>
          {stored && (
            <button
              onClick={() => save(patch(null), `${label} removed.`)}
              disabled={busy || !report.writable}
            >
              Remove
            </button>
          )}
        </div>
        <p className="panel-note" style={{ marginTop: 4 }}>
          {ORIGIN_NOTE[origin]}
          {origin === 'environment' && stored ? ' (the key stored here is ignored)' : ''}
        </p>
      </div>
    );
  };

  return (
    <div className="panel">
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', marginBottom: 4 }}>
          <strong>Provider</strong>
        </label>
        <div className="field-row">
          {(['mock', 'anthropic', 'openai'] as const).map((name) => (
            <button
              key={name}
              className={report.selected === name ? 'primary' : undefined}
              onClick={() => save({ provider: name }, `Provider set to ${name}.`)}
              disabled={busy || !report.writable || report.origins.provider === 'environment'}
            >
              {name}
            </button>
          ))}
        </div>
        <p className="panel-note" style={{ marginTop: 4 }}>
          {report.selected === 'mock'
            ? 'The deterministic stub: answers are canned, nothing leaves this machine, and nothing is billed.'
            : `Requests are sent to ${report.selected}.`}{' '}
          {ORIGIN_NOTE[report.origins.provider]}.
        </p>
      </div>

      {keyRow('Anthropic API key', 'anthropicApiKey', anthropicKey, setAnthropicKey)}
      {keyRow('OpenAI API key', 'openaiApiKey', openaiKey, setOpenaiKey)}

      {saved && (
        <p className="panel-note" style={{ marginBottom: 12 }}>
          <strong>{saved}</strong>
        </p>
      )}

      {!report.writable && (
        <p className="panel-note" style={{ marginBottom: 12 }}>
          <strong>Settings are read-only on this deployment.</strong> Configure the gateway with
          environment variables instead.
        </p>
      )}

      <div className="panel-note">
        <strong>Where this is kept</strong>
        <p style={{ margin: '4px 0 0' }}>
          Keys are written to <code>{report.file}</code> in plain text, beside your documents. An
          environment variable always wins over a key stored here. Anthropic serves no embedding
          model, so semantic search borrows the OpenAI one when a key for it is present, and
          otherwise falls back to a deterministic stub.
        </p>
      </div>
    </div>
  );
}
