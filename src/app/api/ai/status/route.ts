import { NextResponse } from 'next/server';

import { gatewayStatus } from '@/ai/gateway';

/**
 * Reports which provider the gateway would route to. Deliberately makes no
 * request to any provider, so checking configuration costs nothing.
 */
export async function GET() {
  return NextResponse.json(gatewayStatus());
}
