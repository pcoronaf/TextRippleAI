import { NextResponse } from 'next/server';

import { chapterIndex } from '@/core/document';
import { isTrivial } from '@/core/classify';
import { getStore } from '@/store';
import { handleError } from '@/server/http';
import type { ChangesSinceSummary } from '@/core/types';

type Context = { params: Promise<{ id: string }> };

/**
 * The Change Ledger for a document, optionally scoped to a review boundary,
 * together with the "changes since last review" summary the status bar shows.
 */
export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const sinceCheckpointId = url.searchParams.get('since') ?? undefined;
    const includeTrivial = url.searchParams.get('includeTrivial') !== 'false';
    const limit = Number(url.searchParams.get('limit') ?? 200);

    const store = getStore();
    const [changes, checkpoints, document] = await Promise.all([
      store.listChanges(id, { sinceCheckpointId, includeTrivial, limit }),
      store.listCheckpoints(id),
      store.getDocument(id),
    ]);

    const chapters = document ? chapterIndex(document.content) : new Map();
    const counts = new Map<string, { chapterId: string | null; title: string; count: number }>();

    for (const change of changes) {
      const chapter = chapters.get(change.blockId) ?? null;
      const key = chapter?.id ?? '__preamble__';
      const entry = counts.get(key) ?? {
        chapterId: chapter?.id ?? null,
        title: chapter?.title ?? 'Front matter',
        count: 0,
      };
      entry.count++;
      counts.set(key, entry);
    }

    const summary: ChangesSinceSummary = {
      checkpoint: sinceCheckpointId
        ? (checkpoints.find((checkpoint) => checkpoint.id === sinceCheckpointId) ?? null)
        : (checkpoints[0] ?? null),
      total: changes.length,
      substantive: changes.filter((change) => !isTrivial(change.classification)).length,
      trivial: changes.filter((change) => isTrivial(change.classification)).length,
      byChapter: [...counts.values()],
    };

    return NextResponse.json({ changes, summary });
  } catch (error) {
    return handleError(error);
  }
}
