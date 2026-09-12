/**
 * Index maintenance.
 *
 * This layer is where the store and the AI gateway meet; neither imports the
 * other, which is what keeps "the AI layer has no write path to the document"
 * true by construction.
 *
 * Nothing here runs on its own. Indexing is explicit: a request, a checkpoint,
 * or a step that impact analysis takes before it reasons. Invalidate cheaply,
 * recompute lazily.
 */

import { embed, gatewayStatus } from '@/ai/gateway';
import { generateSummary } from '@/ai/summarize';
import { enclosingHeadings, flattenBlocks, regions } from '@/core/document';
import { contentHash } from '@/core/hash';
import { extractSemanticUnits } from '@/core/semantics';
import type { DocumentContent, IndexStatusReport, SummaryType } from '@/core/types';
import { getStore } from '@/store';

export interface RefreshOptions {
  /** Cap the work in one pass so a huge manuscript is indexed incrementally. */
  limit?: number;
  embeddings?: boolean;
  summaries?: boolean;
  semanticUnits?: boolean;
}

export interface RefreshReport {
  documentId: string;
  revision: number;
  embeddingsWritten: number;
  summariesWritten: number;
  semanticUnitsWritten: number;
  /** True when the limit stopped the pass short of a clean index. */
  more: boolean;
  tokens: { input: number; output: number };
  status: IndexStatusReport;
}

const DEFAULT_LIMIT = 200;

/** Blocks whose embedding is missing or stale, in document order. */
async function embeddingWorkList(
  documentId: string,
  content: DocumentContent,
): Promise<{ nodeId: string; text: string }[]> {
  const store = getStore();
  const blocks = flattenBlocks(content).filter((block) => block.text.trim().length > 0);
  const existing = await store.listEmbeddings(documentId);

  const byNode = new Map(existing.map((entry) => [entry.nodeId, entry]));

  return blocks
    .filter((block) => {
      const embedding = byNode.get(block.id);
      if (!embedding) return true;
      if (embedding.status !== 'current') return true;
      // Belt and braces: a hash mismatch means an invalidation was missed.
      return embedding.contentHash !== contentHash(block.text);
    })
    .map((block) => ({ nodeId: block.id, text: block.text }));
}

/**
 * Refresh whatever has gone out of date.
 *
 * Order matters: embeddings and semantic units are per-block and cheap;
 * summaries are built bottom-up afterwards so a chapter brief is written from
 * section briefs that are already current.
 */
export async function refreshIndex(
  documentId: string,
  options: RefreshOptions = {},
): Promise<RefreshReport> {
  const store = getStore();
  const loaded = await store.getDocument(documentId);
  if (!loaded) throw new Error(`Document ${documentId} not found`);

  const { content, document } = loaded;
  const revision = document.currentRevision;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const doEmbeddings = options.embeddings !== false;
  const doSummaries = options.summaries !== false;
  const doUnits = options.semanticUnits !== false;

  let embeddingsWritten = 0;
  let summariesWritten = 0;
  let semanticUnitsWritten = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let more = false;

  // ---- Block embeddings and locally extracted units -----------------------

  if (doEmbeddings || doUnits) {
    const pending = await embeddingWorkList(documentId, content);
    const batch = pending.slice(0, limit);
    more = pending.length > batch.length;

    if (batch.length > 0) {
      if (doEmbeddings) {
        const result = await embed(batch.map((entry) => entry.text));

        for (const [index, entry] of batch.entries()) {
          const vector = result.vectors[index];
          if (!vector) continue;

          await store.upsertEmbedding(documentId, {
            nodeId: entry.nodeId,
            embeddingType: 'block',
            vector,
            contentHash: contentHash(entry.text),
            sourceRevision: revision,
            provider: result.provider,
            model: result.model,
          });
          embeddingsWritten++;
        }
      }

      if (doUnits) {
        // Local pattern rules - no model call, so this is free.
        for (const entry of batch) {
          const units = extractSemanticUnits(entry.text);
          await store.replaceSemanticUnits(documentId, entry.nodeId, units, revision);
          semanticUnitsWritten += units.length;
        }
      }
    }
  }

  // ---- Hierarchical summaries ---------------------------------------------

  if (doSummaries) {
    const existing = await store.listSummaries(documentId);
    const byKey = new Map(
      existing.map((entry) => [`${entry.summaryType}:${entry.nodeId ?? ''}`, entry]),
    );
    const needsWork = (type: SummaryType, nodeId: string | null): boolean => {
      const entry = byKey.get(`${type}:${nodeId ?? ''}`);
      return !entry || entry.status !== 'current';
    };

    const blockText = new Map(flattenBlocks(content).map((block) => [block.id, block.text]));
    const all = regions(content);
    const sections = all.filter((region) => region.level > 1);
    const chapters = all.filter((region) => region.level === 1);

    // Sections first, from their own paragraphs.
    for (const section of sections) {
      if (!needsWork('section', section.headingId)) continue;
      const source = section.blockIds
        .map((id) => blockText.get(id) ?? '')
        .filter(Boolean)
        .join('\n\n');
      if (!source.trim()) continue;

      const summary = await generateSummary({
        type: 'section',
        title: section.title,
        source,
      });
      await store.upsertSummary(documentId, {
        nodeId: section.headingId,
        summaryType: 'section',
        content: summary.content,
        sourceRevision: revision,
        provider: summary.provider,
        model: summary.model,
      });
      summariesWritten++;
      inputTokens += summary.inputTokens;
      outputTokens += summary.outputTokens;
    }

    // Chapters from their section briefs, falling back to paragraphs where a
    // chapter has no subsections.
    const refreshedSections = await store.listSummaries(documentId, { types: ['section'] });
    const sectionByNode = new Map(refreshedSections.map((entry) => [entry.nodeId, entry]));

    const enclosing = enclosingHeadings(content);

    for (const chapter of chapters) {
      if (!needsWork('chapter', chapter.headingId)) continue;

      // A section belongs to the chapter whose heading encloses it. Region
      // block lists exclude headings, so membership cannot be read off them.
      const fromSections = sections
        .filter((section) => enclosing.get(section.headingId)?.chapterId === chapter.headingId)
        .map((section) => sectionByNode.get(section.headingId)?.content)
        .filter((entry): entry is string => Boolean(entry))
        .join('\n\n');

      const source =
        fromSections.trim() ||
        chapter.blockIds
          .map((id) => blockText.get(id) ?? '')
          .filter(Boolean)
          .join('\n\n');
      if (!source.trim()) continue;

      const summary = await generateSummary({
        type: 'chapter',
        title: chapter.title,
        source,
      });
      await store.upsertSummary(documentId, {
        nodeId: chapter.headingId,
        summaryType: 'chapter',
        content: summary.content,
        sourceRevision: revision,
        provider: summary.provider,
        model: summary.model,
      });
      summariesWritten++;
      inputTokens += summary.inputTokens;
      outputTokens += summary.outputTokens;
    }

    // The document brief, from chapter briefs where they exist.
    if (needsWork('document', null)) {
      const refreshedChapters = await store.listSummaries(documentId, { types: ['chapter'] });
      const source =
        refreshedChapters.map((entry) => entry.content).join('\n\n').trim() ||
        flattenBlocks(content)
          .map((block) => block.text)
          .join('\n\n');

      if (source.trim()) {
        const summary = await generateSummary({
          type: 'document',
          title: document.title,
          source,
        });
        await store.upsertSummary(documentId, {
          nodeId: null,
          summaryType: 'document',
          content: summary.content,
          sourceRevision: revision,
          provider: summary.provider,
          model: summary.model,
        });
        summariesWritten++;
        inputTokens += summary.inputTokens;
        outputTokens += summary.outputTokens;
      }
    }
  }

  return {
    documentId,
    revision,
    embeddingsWritten,
    summariesWritten,
    semanticUnitsWritten,
    more,
    tokens: { input: inputTokens, output: outputTokens },
    status: await store.indexStatus(documentId),
  };
}

/** Which provider would be used, reported without contacting it. */
export function indexerProvider(): string {
  return gatewayStatus().selected;
}
