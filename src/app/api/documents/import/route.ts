import { NextResponse } from 'next/server';

import { importDocx } from '@/formats/docx';
import { markdownToContent, textToContent } from '@/formats/markdown';
import { getStore } from '@/store';
import { CURRENT_USER_ID, handleError } from '@/server/http';
import type { DocumentContent } from '@/core/types';

export const maxDuration = 60;

/** Create a document from an uploaded DOCX, Markdown or plain-text file. */
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const name = file.name ?? 'document';
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    let content: DocumentContent;

    if (extension === 'docx') {
      content = await importDocx(Buffer.from(await file.arrayBuffer()));
    } else if (extension === 'md' || extension === 'markdown') {
      content = await markdownToContent(await file.text());
    } else if (extension === 'txt' || extension === '') {
      content = textToContent(await file.text());
    } else if (extension === 'json') {
      content = JSON.parse(await file.text()) as DocumentContent;
    } else {
      return NextResponse.json(
        { error: `Unsupported file type ".${extension}". Use .docx, .md, .txt or .json.` },
        { status: 415 },
      );
    }

    const created = await getStore().createDocument({
      title: name.replace(/\.[^.]+$/, ''),
      content,
      authorId: CURRENT_USER_ID,
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
