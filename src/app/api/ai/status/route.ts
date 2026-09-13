import { NextResponse } from 'next/server';

import { gatewayStatus } from '@/ai/gateway';
// Installs the stored-settings credential source. This is the one route that
// does not otherwise import the server helpers, and reporting the gateway's
// configuration without it would ignore anything saved from the settings panel.
import '@/server/http';

/**
 * Reports which provider the gateway would route to. Deliberately makes no
 * request to any provider, so checking configuration costs nothing.
 */
export async function GET() {
  return NextResponse.json(gatewayStatus());
}
