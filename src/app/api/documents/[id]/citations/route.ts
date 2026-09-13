import { NextResponse } from 'next/server';

import { getStore } from '@/store';
import { handleError } from '@/server/http';

type Context = { params: Promise<{ id: string }> };

/**
 * Citation management, over what the index already extracted.
 *
 * Each distinct reference, where it is used, and - the part that matters for a
 * change-aware editor - whether any passage citing it has been edited since the
 * last review boundary. A source that still supports a claim it was chosen for
 * is fine; one whose claim has moved on needs looking at.
 */
export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const since = new URL(request.url).searchParams.get('since') ?? undefined;

    const store = getStore();
    const [units, changes, document] = await Promise.all([
      store.listSemanticUnits(id, { types: ['citation'] }),
      store.listChanges(id, { sinceCheckpointId: since, limit: 1000 }),
      store.getDocument(id),
    ]);

    if (!document) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    const changedBlocks = new Set(changes.map((change) => change.blockId));
    const grouped = new Map<
      string,
      { value: string; blockIds: string[]; changedBlockIds: string[] }
    >();

    for (const unit of units) {
      const key = unit.value.toLowerCase();
      const entry = grouped.get(key) ?? { value: unit.value, blockIds: [], changedBlockIds: [] };

      if (!entry.blockIds.includes(unit.nodeId)) entry.blockIds.push(unit.nodeId);
      if (changedBlocks.has(unit.nodeId) && !entry.changedBlockIds.includes(unit.nodeId)) {
        entry.changedBlockIds.push(unit.nodeId);
      }

      grouped.set(key, entry);
    }

    const citations = [...grouped.values()].sort(
      (a, b) => b.blockIds.length - a.blockIds.length || a.value.localeCompare(b.value),
    );

    return NextResponse.json({
      citations,
      needsReview: citations.filter((entry) => entry.changedBlockIds.length > 0).length,
    });
  } catch (error) {
    return handleError(error);
  }
}
