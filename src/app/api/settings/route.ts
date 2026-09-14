import { NextResponse } from 'next/server';

import { gatewayStatus } from '@/ai/gateway';
import { handleError } from '@/server/http';
import {
  readSettings,
  settingsAreWritable,
  settingsPath,
  writeSettings,
  type StoredProvider,
} from '@/server/settings';

const PROVIDERS: StoredProvider[] = ['anthropic', 'openai', 'bridge', 'mock'];

/**
 * What is configured - never the keys themselves.
 *
 * A stored key is reported as present, not returned. There is no reason for a
 * secret to travel back to the browser, and an endpoint that hands one out is
 * an endpoint that eventually hands it to the wrong caller.
 */
export async function GET() {
  try {
    const stored = readSettings();
    const status = gatewayStatus();

    return NextResponse.json({
      selected: status.selected,
      origins: status.origins,
      providers: status.providers,
      stored: {
        provider: stored.provider ?? null,
        anthropicApiKey: Boolean(stored.anthropicApiKey),
        openaiApiKey: Boolean(stored.openaiApiKey),
      },
      writable: settingsAreWritable(),
      file: settingsPath(),
    });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Change the provider or store a key.
 *
 * `null` clears a field, an omitted field is left alone. Nothing here is
 * logged: the body carries a secret.
 */
export async function POST(request: Request) {
  try {
    if (!settingsAreWritable()) {
      return NextResponse.json(
        { error: 'Settings are read-only on this deployment; configure the gateway by environment variable.' },
        { status: 403 },
      );
    }

    const body = (await request.json()) as {
      provider?: unknown;
      anthropicApiKey?: unknown;
      openaiApiKey?: unknown;
    };

    if (body.provider !== undefined && body.provider !== null) {
      if (typeof body.provider !== 'string' || !PROVIDERS.includes(body.provider as StoredProvider)) {
        return NextResponse.json(
          { error: `provider must be one of ${PROVIDERS.join(', ')}` },
          { status: 400 },
        );
      }
    }

    for (const field of ['anthropicApiKey', 'openaiApiKey'] as const) {
      const value = body[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return NextResponse.json({ error: `${field} must be a string or null` }, { status: 400 });
      }
    }

    writeSettings({
      provider: body.provider as StoredProvider | null | undefined,
      anthropicApiKey: body.anthropicApiKey as string | null | undefined,
      openaiApiKey: body.openaiApiKey as string | null | undefined,
    });

    // Report the resulting configuration, so the caller sees whether the key it
    // just stored is actually the one in use or is shadowed by the environment.
    return GET();
  } catch (error) {
    return handleError(error);
  }
}
