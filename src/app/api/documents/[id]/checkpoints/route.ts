import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    return NextResponse.json({ checkpoints: await getStore().listCheckpoints(id) });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const checkpoint = await getStore().createCheckpoint(id, {
      name: typeof body.name === 'string' ? body.name : '',
      createdBy: CURRENT_USER_ID,
    });
    return NextResponse.json(checkpoint, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
