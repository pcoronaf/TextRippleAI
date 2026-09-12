import { NextResponse } from 'next/server';

import { contentToText, exportDocx } from '@/formats/docx';
import { contentToMarkdown } from '@/formats/markdown';
import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function filename(title: string, extension: string): string {
  const safe = title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'document';
  return `${safe}.${extension}`;
}

export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const format = new URL(request.url).searchParams.get('format') ?? 'docx';

    const document = await getStore().getDocument(id);
    if (!document) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    const { content, document: meta } = document;

    if (format === 'json') {
      return NextResponse.json(content, {
        headers: {
          'content-disposition': `attachment; filename="${filename(meta.title, 'json')}"`,
        },
      });
    }

    if (format === 'md' || format === 'markdown') {
      return new NextResponse(contentToMarkdown(content), {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${filename(meta.title, 'md')}"`,
        },
      });
    }

    if (format === 'txt' || format === 'text') {
      return new NextResponse(contentToText(content), {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${filename(meta.title, 'txt')}"`,
        },
      });
    }

    const buffer = await exportDocx(content, meta.title);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': DOCX_MIME,
        'content-disposition': `attachment; filename="${filename(meta.title, 'docx')}"`,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
