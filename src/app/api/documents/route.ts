import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';

export async function GET() {
  try {
    return NextResponse.json({ documents: await getStore().listDocuments() });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const created = await getStore().createDocument({
      title: body.title,
      content: body.content,
      authorId: CURRENT_USER_ID,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
