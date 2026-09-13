/**
 * Zero-install store: one JSON file per document under `DATA_DIR`.
 *
 * This exists so `npm run dev` works on a machine with nothing but Node. It is
 * intended for local drafting and the test suite, not for deployment - see
 * `postgres-store.ts` for the real target.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { replaceBlockText } from '@/core/apply';
import { planInvalidation } from '@/core/index-plan';
import { cosineSimilarity } from '@/core/vector';
import {
  emptyDocument,
  ensureNodeIds,
  flattenBlocks,
  inferTitle,
  regions,
} from '@/core/document';
import { contentHash } from '@/core/hash';
import {
  newChangeId,
  newCheckpointId,
  newConversationId,
  newDecisionId,
  newDocumentId,
  newEmbeddingId,
  newImpactAnalysisId,
  newImpactId,
  newMessageId,
  newSemanticUnitId,
  newSuggestionRecordId,
  newSummaryId,
} from '@/core/ids';
import { classifyChange, isTrivial } from '@/core/classify';
import type {
  ChangeRecord,
  CheckpointRecord,
  ConversationRecord,
  DecisionRecord,
  DecisionStatus,
  DocumentContent,
  DocumentNodeRecord,
  DocumentRecord,
  DocumentWithContent,
  EmbeddingRecord,
  ImpactAnalysisRecord,
  ImpactRecord,
  ImpactStatusValue,
  IndexStatusReport,
  MessageRecord,
  SemanticUnitRecord,
  SuggestionRecord,
  SummaryRecord,
  SummaryType,
} from '@/core/types';
import type { DetectedUnit } from '@/core/semantics';

import { buildNodeRecords, toChangeRecords } from './records';
import {
  ConversationNotFoundError,
  DocumentNotFoundError,
  RevisionConflictError,
  SuggestionNotFoundError,
  SuggestionResolvedError,
  SuggestionStaleError,
  ImpactAnalysisNotFoundError,
  ImpactNotFoundError,
  DecisionNotFoundError,
  type AcceptSuggestionInput,
  type AcceptSuggestionResult,
  type AppendMessageInput,
  type CreateConversationInput,
  type CreateSuggestionInput,
  type CreateDocumentInput,
  type CompleteImpactAnalysisInput,
  type CreateDecisionInput,
  type CreateImpactAnalysisInput,
  type UpdateDecisionInput,
  type EmbeddingUpsert,
  type ListChangesOptions,
  type ListSuggestionsOptions,
  type SaveDocumentInput,
  type SummaryUpsert,
  type TextHit,
  type VectorHit,
  type SaveDocumentResult,
  type Store,
} from './types';

interface StoredVersion {
  revision: number;
  content: DocumentContent;
  createdAt: string;
  createdBy: string;
}

interface DocumentFile {
  document: DocumentRecord;
  content: DocumentContent;
  nodes: DocumentNodeRecord[];
  changes: ChangeRecord[];
  checkpoints: CheckpointRecord[];
  versions: StoredVersion[];
  // Added in M2/M3/M4; files written before then will not carry these.
  conversations?: ConversationRecord[];
  messages?: MessageRecord[];
  suggestions?: SuggestionRecord[];
  summaries?: SummaryRecord[];
  embeddings?: EmbeddingRecord[];
  semanticUnits?: SemanticUnitRecord[];
  impactAnalyses?: ImpactAnalysisRecord[];
  impacts?: ImpactRecord[];
  decisions?: DecisionRecord[];
}

/**
 * Apply the invalidation a write implies.
 *
 * Called from every path that changes block text, so nothing can leave the
 * index claiming to be current when the text beneath it has moved on. Blocks
 * that disappeared take their derived artifacts with them.
 */
function invalidate(
  data: DocumentFile,
  content: DocumentContent,
  changedNodeIds: string[],
  removedNodeIds: string[],
): Pick<DocumentFile, 'summaries' | 'embeddings' | 'semanticUnits'> {
  const removed = new Set(removedNodeIds);

  let embeddings = (data.embeddings ?? []).filter((entry) => !removed.has(entry.nodeId));
  let summaries = (data.summaries ?? []).filter(
    (entry) => entry.nodeId === null || !removed.has(entry.nodeId),
  );
  const semanticUnits = (data.semanticUnits ?? []).filter((entry) => !removed.has(entry.nodeId));

  if (changedNodeIds.length === 0) return { summaries, embeddings, semanticUnits };

  const plan = planInvalidation(content, changedNodeIds);
  const staleBlocks = new Set(plan.staleBlockIds);
  const staleSummaries = new Set(plan.staleSummaryNodeIds);
  const suspectSummaries = new Set(plan.potentiallyStaleSummaryNodeIds);
  const now = new Date().toISOString();

  embeddings = embeddings.map((entry) =>
    staleBlocks.has(entry.nodeId) ? { ...entry, status: 'stale' as const, updatedAt: now } : entry,
  );

  summaries = summaries.map((entry) => {
    if (entry.nodeId && staleSummaries.has(entry.nodeId)) {
      return { ...entry, status: 'stale' as const, updatedAt: now };
    }
    if (entry.nodeId && suspectSummaries.has(entry.nodeId)) {
      return { ...entry, status: 'potentially_stale' as const, updatedAt: now };
    }
    if (entry.nodeId === null && plan.documentSummaryAffected && entry.status === 'current') {
      return { ...entry, status: 'potentially_stale' as const, updatedAt: now };
    }
    return entry;
  });

  return { summaries, embeddings, semanticUnits };
}

/** Snapshots retained per document; checkpoint revisions are always kept. */
const MAX_RETAINED_VERSIONS = 25;

export class FileStore implements Store {
  readonly kind = 'file' as const;

  private readonly root: string;
  /** Serialises writes per document so concurrent saves cannot interleave. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, 'documents');
  }

  private file(id: string): string {
    // IDs are generated internally and contain only [A-Za-z0-9_-]; reject
    // anything else rather than let a request shape a filesystem path.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new DocumentNotFoundError(id);
    return path.join(this.root, `${id}.json`);
  }

  private async read(id: string): Promise<DocumentFile | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as DocumentFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async write(data: DocumentFile): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const target = this.file(data.document.id);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(temp, target);
  }

  /** Run `task` after any write already queued for this document. */
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const documents: DocumentRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const data = await this.read(entry.replace(/\.json$/, ''));
      if (data) documents.push(data.document);
    }
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentWithContent> {
    const id = newDocumentId();
    const now = new Date().toISOString();
    const { content } = ensureNodeIds(input.content ?? emptyDocument());
    const title = input.title?.trim() || inferTitle(content);

    const document: DocumentRecord = {
      id,
      workspaceId: input.workspaceId ?? 'ws_local',
      title,
      currentRevision: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };

    await this.enqueue(id, async () => {
      await this.write({
        document,
        content,
        nodes: buildNodeRecords(id, content, 1),
        changes: [],
        checkpoints: [],
        versions: [{ revision: 1, content, createdAt: now, createdBy: input.authorId }],
      });
    });

    return { document, content };
  }

  async getDocument(id: string): Promise<DocumentWithContent | null> {
    const data = await this.read(id);
    return data ? { document: data.document, content: data.content } : null;
  }

  async saveDocument(id: string, input: SaveDocumentInput): Promise<SaveDocumentResult> {
    return this.enqueue(id, async () => {
      const data = await this.read(id);
      if (!data) throw new DocumentNotFoundError(id);
      if (data.document.currentRevision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, data.document.currentRevision);
      }

      const revision = data.document.currentRevision + 1;
      const now = new Date().toISOString();
      const { content } = ensureNodeIds(input.content);

      const changes = toChangeRecords(id, input.changes, {
        authorId: input.authorId,
        source: input.source ?? 'human',
        revision,
      });

      const document: DocumentRecord = {
        ...data.document,
        title: input.title?.trim() || inferTitle(content, data.document.title),
        currentRevision: revision,
        updatedAt: now,
      };

      const checkpointRevisions = new Set(data.checkpoints.map((cp) => cp.revision));
      const versions = [
        ...data.versions,
        { revision, content, createdAt: now, createdBy: input.authorId },
      ];
      const retained = versions.filter(
        (version, index) =>
          checkpointRevisions.has(version.revision) ||
          index >= versions.length - MAX_RETAINED_VERSIONS,
      );

      const nodes = buildNodeRecords(id, content, revision, data.nodes);
      const surviving = new Set(nodes.map((node) => node.id));

      await this.write({
        ...data,
        document,
        content,
        nodes,
        changes: [...data.changes, ...changes],
        checkpoints: data.checkpoints,
        versions: retained,
        // Derived artifacts go stale in the same write that moved the text.
        ...invalidate(
          data,
          content,
          nodes.filter((node) => node.revision === revision).map((node) => node.id),
          data.nodes.filter((node) => !surviving.has(node.id)).map((node) => node.id),
        ),
      });

      return { document, changes };
    });
  }

  async deleteDocument(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      await fs.rm(this.file(id), { force: true });
    });
  }

  async listNodes(documentId: string): Promise<DocumentNodeRecord[]> {
    const data = await this.read(documentId);
    return data?.nodes ?? [];
  }

  async listChanges(documentId: string, options: ListChangesOptions = {}): Promise<ChangeRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    let changes = [...data.changes].sort((a, b) => {
      if (a.revision !== b.revision) return b.revision - a.revision;
      return b.createdAt.localeCompare(a.createdAt);
    });

    if (options.sinceCheckpointId) {
      const checkpoint = data.checkpoints.find((cp) => cp.id === options.sinceCheckpointId);
      if (checkpoint) changes = changes.filter((change) => change.revision > checkpoint.revision);
    }
    if (options.includeTrivial === false) {
      changes = changes.filter((change) => !isTrivial(change.classification));
    }
    if (options.limit) changes = changes.slice(0, options.limit);

    return changes;
  }

  async createCheckpoint(
    documentId: string,
    input: { name: string; createdBy: string },
  ): Promise<CheckpointRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const checkpoint: CheckpointRecord = {
        id: newCheckpointId(),
        documentId,
        name: input.name.trim() || `Checkpoint at revision ${data.document.currentRevision}`,
        revision: data.document.currentRevision,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      };

      // Seal every change that has accumulated since the previous checkpoint.
      const changes = data.changes.map((change) =>
        change.checkpointId ? change : { ...change, checkpointId: checkpoint.id },
      );

      await this.write({
        ...data,
        changes,
        checkpoints: [...data.checkpoints, checkpoint],
      });

      return checkpoint;
    });
  }

  async listCheckpoints(documentId: string): Promise<CheckpointRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);
    return [...data.checkpoints].sort((a, b) => b.revision - a.revision);
  }

  async listVersions(
    documentId: string,
  ): Promise<{ revision: number; createdAt: string; createdBy: string }[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);
    return data.versions
      .map(({ revision, createdAt, createdBy }) => ({ revision, createdAt, createdBy }))
      .sort((a, b) => b.revision - a.revision);
  }

  async getVersion(documentId: string, revision: number): Promise<DocumentContent | null> {
    const data = await this.read(documentId);
    return data?.versions.find((version) => version.revision === revision)?.content ?? null;
  }

  // ---- Conversations ------------------------------------------------------

  async createConversation(
    documentId: string,
    input: CreateConversationInput,
  ): Promise<ConversationRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const now = new Date().toISOString();
      const conversation: ConversationRecord = {
        id: newConversationId(),
        documentId,
        anchorBlockId: input.anchorBlockId,
        selection: input.selection,
        selectionText: input.selectionText,
        title: input.title,
        relatedChangeId: null,
        relatedImpactId: input.relatedImpactId ?? null,
        createdAt: now,
        updatedAt: now,
      };

      await this.write({
        ...data,
        conversations: [...(data.conversations ?? []), conversation],
      });

      return conversation;
    });
  }

  async getConversation(
    documentId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    const data = await this.read(documentId);
    return (data?.conversations ?? []).find((entry) => entry.id === conversationId) ?? null;
  }

  async listConversations(
    documentId: string,
    options: { anchorBlockId?: string } = {},
  ): Promise<ConversationRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.conversations ?? [])
      .filter(
        (conversation) =>
          !options.anchorBlockId || conversation.anchorBlockId === options.anchorBlockId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendMessage(
    documentId: string,
    conversationId: string,
    input: AppendMessageInput,
  ): Promise<MessageRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const conversations = data.conversations ?? [];
      if (!conversations.some((entry) => entry.id === conversationId)) {
        throw new ConversationNotFoundError(conversationId);
      }

      const now = new Date().toISOString();
      const message: MessageRecord = {
        id: newMessageId(),
        conversationId,
        role: input.role,
        content: input.content,
        provider: input.provider ?? null,
        model: input.model ?? null,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        contextDigest: input.contextDigest ?? null,
        createdAt: now,
      };

      await this.write({
        ...data,
        conversations: conversations.map((entry) =>
          entry.id === conversationId ? { ...entry, updatedAt: now } : entry,
        ),
        messages: [...(data.messages ?? []), message],
      });

      return message;
    });
  }

  async listMessages(documentId: string, conversationId: string): Promise<MessageRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.messages ?? [])
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---- Suggestions --------------------------------------------------------

  async createSuggestion(
    documentId: string,
    input: CreateSuggestionInput,
  ): Promise<SuggestionRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const suggestion: SuggestionRecord = {
        id: newSuggestionRecordId(),
        documentId,
        ...input,
        sourceImpactId: input.sourceImpactId ?? null,
        status: 'generated',
        changeId: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      };

      await this.write({
        ...data,
        suggestions: [...(data.suggestions ?? []), suggestion],
      });

      return suggestion;
    });
  }

  async getSuggestion(
    documentId: string,
    suggestionId: string,
  ): Promise<SuggestionRecord | null> {
    const data = await this.read(documentId);
    return (data?.suggestions ?? []).find((entry) => entry.id === suggestionId) ?? null;
  }

  async listSuggestions(
    documentId: string,
    options: ListSuggestionsOptions = {},
  ): Promise<SuggestionRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.suggestions ?? [])
      .filter((entry) => !options.blockId || entry.blockId === options.blockId)
      .filter((entry) => !options.statuses || options.statuses.includes(entry.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async setSuggestionStatus(
    documentId: string,
    suggestionId: string,
    input: { status: Exclude<SuggestionRecord['status'], 'accepted'>; resolvedBy?: string },
  ): Promise<SuggestionRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const suggestions = data.suggestions ?? [];
      const current = suggestions.find((entry) => entry.id === suggestionId);
      if (!current) throw new SuggestionNotFoundError(suggestionId);
      if (isResolvedSuggestion(current)) throw new SuggestionResolvedError(suggestionId, current.status);

      const terminal = input.status === 'rejected' || input.status === 'revised';
      const updated: SuggestionRecord = {
        ...current,
        status: input.status,
        resolvedBy: terminal ? (input.resolvedBy ?? current.resolvedBy) : current.resolvedBy,
        resolvedAt: terminal ? new Date().toISOString() : current.resolvedAt,
      };

      await this.write({
        ...data,
        suggestions: suggestions.map((entry) => (entry.id === suggestionId ? updated : entry)),
      });

      return updated;
    });
  }

  async acceptSuggestion(
    documentId: string,
    suggestionId: string,
    input: AcceptSuggestionInput,
  ): Promise<AcceptSuggestionResult> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const suggestions = data.suggestions ?? [];
      const suggestion = suggestions.find((entry) => entry.id === suggestionId);
      if (!suggestion) throw new SuggestionNotFoundError(suggestionId);
      if (isResolvedSuggestion(suggestion)) throw new SuggestionResolvedError(suggestionId, suggestion.status);

      if (data.document.currentRevision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, data.document.currentRevision);
      }

      // The proposal was written against a particular passage. If the author
      // has edited it since, applying the proposal would quietly throw their
      // work away.
      const block = flattenBlocks(data.content).find((entry) => entry.id === suggestion.blockId);
      if (!block || block.text !== suggestion.before) {
        throw new SuggestionStaleError(suggestionId);
      }

      const revision = data.document.currentRevision + 1;
      const now = new Date().toISOString();
      const { content } = ensureNodeIds(
        replaceBlockText(data.content, suggestion.blockId, suggestion.proposed),
      );

      const change: ChangeRecord = {
        id: newChangeId(),
        documentId,
        blockId: suggestion.blockId,
        blockType: block.type,
        operation: 'replace',
        before: block.text,
        after: suggestion.proposed,
        beforeHash: contentHash(block.text),
        afterHash: contentHash(suggestion.proposed),
        classification: classifyChange({
          blockType: block.type,
          operation: 'replace',
          before: block.text,
          after: suggestion.proposed,
        }),
        // For an accepted proposal the "session" is the conversation it came
        // out of, which is what someone tracing the edit would want next.
        sessionId: suggestion.conversationId ?? suggestionId,
        occurredAt: now,
        authorId: input.acceptedBy,
        source: suggestion.sourceImpactId ? 'propagation' : 'ai_accepted',
        revision,
        checkpointId: null,
        impactStatus: 'pending',
        prompt: suggestion.instruction,
        model: suggestion.model ? `${suggestion.provider ?? 'unknown'}:${suggestion.model}` : null,
        suggestionId,
        createdAt: now,
      };

      const accepted: SuggestionRecord = {
        ...suggestion,
        status: 'accepted',
        changeId: change.id,
        resolvedBy: input.acceptedBy,
        resolvedAt: now,
      };

      const document: DocumentRecord = {
        ...data.document,
        title: inferTitle(content, data.document.title),
        currentRevision: revision,
        updatedAt: now,
      };

      const checkpointRevisions = new Set(data.checkpoints.map((checkpoint) => checkpoint.revision));
      const versions = [
        ...data.versions,
        { revision, content, createdAt: now, createdBy: input.acceptedBy },
      ];
      const retained = versions.filter(
        (version, index) =>
          checkpointRevisions.has(version.revision) ||
          index >= versions.length - MAX_RETAINED_VERSIONS,
      );

      const nodes = buildNodeRecords(documentId, content, revision, data.nodes);
      const surviving = new Set(nodes.map((node) => node.id));

      await this.write({
        ...data,
        document,
        content,
        nodes,
        changes: [...data.changes, change],
        versions: retained,
        suggestions: suggestions.map((entry) => (entry.id === suggestionId ? accepted : entry)),
        ...invalidate(
          data,
          content,
          nodes.filter((node) => node.revision === revision).map((node) => node.id),
          data.nodes.filter((node) => !surviving.has(node.id)).map((node) => node.id),
        ),
      });

      return { document, content, change, suggestion: accepted };
    });
  }

  // ---- Semantic index -----------------------------------------------------

  async listSummaries(
    documentId: string,
    options: { types?: SummaryType[]; statuses?: IndexStatusReport['summaries'][number]['type'][] | string[] } = {},
  ): Promise<SummaryRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.summaries ?? [])
      .filter((entry) => !options.types || options.types.includes(entry.summaryType))
      .filter(
        (entry) => !options.statuses || (options.statuses as string[]).includes(entry.status),
      );
  }

  async upsertSummary(documentId: string, input: SummaryUpsert): Promise<SummaryRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const summaries = data.summaries ?? [];
      const now = new Date().toISOString();
      const existing = summaries.find(
        (entry) => entry.summaryType === input.summaryType && entry.nodeId === input.nodeId,
      );

      const record: SummaryRecord = {
        id: existing?.id ?? newSummaryId(),
        documentId,
        nodeId: input.nodeId,
        summaryType: input.summaryType,
        content: input.content,
        sourceRevision: input.sourceRevision,
        status: 'current',
        provider: input.provider,
        model: input.model,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await this.write({
        ...data,
        summaries: existing
          ? summaries.map((entry) => (entry.id === existing.id ? record : entry))
          : [...summaries, record],
      });

      return record;
    });
  }

  async listEmbeddings(
    documentId: string,
    options: { statuses?: string[]; nodeIds?: string[] } = {},
  ): Promise<EmbeddingRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.embeddings ?? [])
      .filter((entry) => !options.statuses || options.statuses.includes(entry.status))
      .filter((entry) => !options.nodeIds || options.nodeIds.includes(entry.nodeId));
  }

  async upsertEmbedding(documentId: string, input: EmbeddingUpsert): Promise<EmbeddingRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const embeddings = data.embeddings ?? [];
      const now = new Date().toISOString();
      const existing = embeddings.find(
        (entry) => entry.nodeId === input.nodeId && entry.embeddingType === input.embeddingType,
      );

      const record: EmbeddingRecord = {
        id: existing?.id ?? newEmbeddingId(),
        documentId,
        nodeId: input.nodeId,
        embeddingType: input.embeddingType,
        vector: input.vector,
        contentHash: input.contentHash,
        sourceRevision: input.sourceRevision,
        status: 'current',
        provider: input.provider,
        model: input.model,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await this.write({
        ...data,
        embeddings: existing
          ? embeddings.map((entry) => (entry.id === existing.id ? record : entry))
          : [...embeddings, record],
      });

      return record;
    });
  }

  async listSemanticUnits(
    documentId: string,
    options: { nodeIds?: string[]; types?: SemanticUnitRecord['unitType'][] } = {},
  ): Promise<SemanticUnitRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.semanticUnits ?? [])
      .filter((entry) => !options.nodeIds || options.nodeIds.includes(entry.nodeId))
      .filter((entry) => !options.types || options.types.includes(entry.unitType));
  }

  async replaceSemanticUnits(
    documentId: string,
    nodeId: string,
    units: DetectedUnit[],
    sourceRevision: number,
  ): Promise<void> {
    await this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const now = new Date().toISOString();
      const kept = (data.semanticUnits ?? []).filter((entry) => entry.nodeId !== nodeId);
      const added: SemanticUnitRecord[] = units.map((unit) => ({
        id: newSemanticUnitId(),
        documentId,
        nodeId,
        unitType: unit.type,
        value: unit.value,
        context: unit.context,
        rule: unit.rule,
        sourceRevision,
        createdAt: now,
      }));

      await this.write({ ...data, semanticUnits: [...kept, ...added] });
    });
  }

  /**
   * Lexical retrieval.
   *
   * PostgreSQL has a real full-text index; here the fallback scores by how many
   * distinct query terms a block contains, which is enough to make exact
   * terminology beat mere similarity in the fused ranking.
   */
  async searchText(documentId: string, query: string, limit: number): Promise<TextHit[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    return flattenBlocks(data.content)
      .map((block) => {
        const haystack = block.text.toLowerCase();
        const matched = terms.filter((term) => haystack.includes(term));
        const density = matched.length / terms.length;
        return { nodeId: block.id, text: block.text, rank: density * (matched.length > 0 ? 1 : 0) };
      })
      .filter((hit) => hit.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);
  }

  async searchVector(
    documentId: string,
    vector: number[],
    limit: number,
  ): Promise<VectorHit[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    const text = new Map(flattenBlocks(data.content).map((block) => [block.id, block.text]));

    return (data.embeddings ?? [])
      .filter((entry) => entry.embeddingType === 'block' && text.has(entry.nodeId))
      .map((entry) => ({
        nodeId: entry.nodeId,
        text: text.get(entry.nodeId) ?? '',
        similarity: cosineSimilarity(vector, entry.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async indexStatus(documentId: string): Promise<IndexStatusReport> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    const blocks = flattenBlocks(data.content);
    const embeddings = data.embeddings ?? [];
    const summaries = data.summaries ?? [];
    const embedded = new Set(embeddings.map((entry) => entry.nodeId));

    const expected = expectedSummaries(data.content);

    return {
      documentId,
      revision: data.document.currentRevision,
      blocks: blocks.length,
      embeddings: {
        current: embeddings.filter((entry) => entry.status === 'current').length,
        stale: embeddings.filter((entry) => entry.status !== 'current').length,
        missing: blocks.filter((block) => !embedded.has(block.id)).length,
      },
      summaries: (['document', 'chapter', 'section'] as SummaryType[]).map((type) => {
        const forType = summaries.filter((entry) => entry.summaryType === type);
        const present = new Set(forType.map((entry) => entry.nodeId));
        return {
          type,
          current: forType.filter((entry) => entry.status === 'current').length,
          stale: forType.filter((entry) => entry.status === 'stale').length,
          potentiallyStale: forType.filter((entry) => entry.status === 'potentially_stale').length,
          missing: expected[type].filter((nodeId) => !present.has(nodeId)).length,
        };
      }),
      semanticUnits: (data.semanticUnits ?? []).length,
    };
  }

  // ---- Impact analysis ----------------------------------------------------

  async createImpactAnalysis(
    documentId: string,
    input: CreateImpactAnalysisInput,
  ): Promise<ImpactAnalysisRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const analysis: ImpactAnalysisRecord = {
        id: newImpactAnalysisId(),
        documentId,
        baseCheckpointId: input.baseCheckpointId,
        targetRevision: input.targetRevision,
        status: 'running',
        summary: '',
        clusters: input.clusters,
        retrieval: input.retrieval,
        changesAnalysed: input.changesAnalysed,
        changesFiltered: input.changesFiltered,
        provider: null,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };

      await this.write({
        ...data,
        impactAnalyses: [...(data.impactAnalyses ?? []), analysis],
      });

      return analysis;
    });
  }

  async completeImpactAnalysis(
    documentId: string,
    analysisId: string,
    input: CompleteImpactAnalysisInput,
  ): Promise<ImpactAnalysisRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const analyses = data.impactAnalyses ?? [];
      const existing = analyses.find((entry) => entry.id === analysisId);
      if (!existing) throw new ImpactAnalysisNotFoundError(analysisId);

      const now = new Date().toISOString();
      const analysis: ImpactAnalysisRecord = {
        ...existing,
        status: input.status,
        summary: input.summary,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        error: input.error ?? null,
        completedAt: now,
      };

      const impacts: ImpactRecord[] = input.impacts.map((impact) => ({
        id: newImpactId(),
        impactAnalysisId: analysisId,
        documentId,
        ...impact,
        status: 'pending' as const,
        suggestionId: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: now,
      }));

      await this.write({
        ...data,
        impactAnalyses: analyses.map((entry) => (entry.id === analysisId ? analysis : entry)),
        impacts: [...(data.impacts ?? []), ...impacts],
      });

      return analysis;
    });
  }

  async getImpactAnalysis(
    documentId: string,
    analysisId: string,
  ): Promise<{ analysis: ImpactAnalysisRecord; impacts: ImpactRecord[] } | null> {
    const data = await this.read(documentId);
    if (!data) return null;

    const analysis = (data.impactAnalyses ?? []).find((entry) => entry.id === analysisId);
    if (!analysis) return null;

    return {
      analysis,
      impacts: (data.impacts ?? []).filter((entry) => entry.impactAnalysisId === analysisId),
    };
  }

  async listImpactAnalyses(documentId: string): Promise<ImpactAnalysisRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return [...(data.impactAnalyses ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listImpacts(
    documentId: string,
    options: { analysisId?: string; statuses?: ImpactStatusValue[] } = {},
  ): Promise<ImpactRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.impacts ?? [])
      .filter((entry) => !options.analysisId || entry.impactAnalysisId === options.analysisId)
      .filter((entry) => !options.statuses || options.statuses.includes(entry.status));
  }

  async setImpactStatus(
    documentId: string,
    impactId: string,
    input: { status: ImpactStatusValue; resolvedBy: string; suggestionId?: string | null },
  ): Promise<ImpactRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const impacts = data.impacts ?? [];
      const existing = impacts.find((entry) => entry.id === impactId);
      if (!existing) throw new ImpactNotFoundError(impactId);

      const updated: ImpactRecord = {
        ...existing,
        status: input.status,
        suggestionId: input.suggestionId ?? existing.suggestionId,
        resolvedBy: input.status === 'pending' ? null : input.resolvedBy,
        resolvedAt: input.status === 'pending' ? null : new Date().toISOString(),
      };

      await this.write({
        ...data,
        impacts: impacts.map((entry) => (entry.id === impactId ? updated : entry)),
      });

      return updated;
    });
  }

  // ---- Decisions ----------------------------------------------------------

  async createDecision(
    documentId: string,
    input: CreateDecisionInput,
  ): Promise<DecisionRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const now = new Date().toISOString();
      const decision: DecisionRecord = {
        id: newDecisionId(),
        documentId,
        title: input.title,
        description: input.description,
        scope: input.scope,
        status: 'accepted',
        source: input.source,
        suppressBlockId: input.suppressBlockId ?? null,
        suppressTerms: input.suppressTerms ?? [],
        suppressImpactType: input.suppressImpactType ?? null,
        sourceImpactId: input.sourceImpactId ?? null,
        sourceConversationId: input.sourceConversationId ?? null,
        supersedesDecisionId: input.supersedesDecisionId ?? null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };

      // Superseding is part of the same write: there is never a moment where
      // both the old and the new decision are in force.
      const existing = (data.decisions ?? []).map((entry) =>
        input.supersedesDecisionId && entry.id === input.supersedesDecisionId
          ? { ...entry, status: 'superseded' as const, updatedAt: now }
          : entry,
      );

      await this.write({ ...data, decisions: [...existing, decision] });
      return decision;
    });
  }

  async getDecision(documentId: string, decisionId: string): Promise<DecisionRecord | null> {
    const data = await this.read(documentId);
    return (data?.decisions ?? []).find((entry) => entry.id === decisionId) ?? null;
  }

  async listDecisions(
    documentId: string,
    options: { statuses?: DecisionStatus[] } = {},
  ): Promise<DecisionRecord[]> {
    const data = await this.read(documentId);
    if (!data) throw new DocumentNotFoundError(documentId);

    return (data.decisions ?? [])
      .filter((entry) => !options.statuses || options.statuses.includes(entry.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateDecision(
    documentId: string,
    decisionId: string,
    input: UpdateDecisionInput,
  ): Promise<DecisionRecord> {
    return this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const decisions = data.decisions ?? [];
      const existing = decisions.find((entry) => entry.id === decisionId);
      if (!existing) throw new DecisionNotFoundError(decisionId);

      const updated: DecisionRecord = {
        ...existing,
        title: input.title ?? existing.title,
        description: input.description ?? existing.description,
        scope: input.scope ?? existing.scope,
        status: input.status ?? existing.status,
        updatedAt: new Date().toISOString(),
      };

      await this.write({
        ...data,
        decisions: decisions.map((entry) => (entry.id === decisionId ? updated : entry)),
      });

      return updated;
    });
  }

  async markChangesAnalysed(documentId: string, changeIds: string[]): Promise<void> {
    if (changeIds.length === 0) return;

    await this.enqueue(documentId, async () => {
      const data = await this.read(documentId);
      if (!data) throw new DocumentNotFoundError(documentId);

      const target = new Set(changeIds);
      await this.write({
        ...data,
        changes: data.changes.map((change) =>
          target.has(change.id) ? { ...change, impactStatus: 'analyzed' as const } : change,
        ),
      });
    });
  }
}

/** Impact-analysis methods, appended to the file store. */
export interface StoredImpactData {
  impactAnalyses?: ImpactAnalysisRecord[];
  impacts?: ImpactRecord[];
  decisions?: DecisionRecord[];
}

/** Which summaries a document ought to have, by type. */
export function expectedSummaries(
  content: DocumentContent,
): Record<SummaryType, (string | null)[]> {
  const all = regions(content);
  return {
    document: [null],
    chapter: all.filter((region) => region.level === 1).map((region) => region.headingId),
    section: all.filter((region) => region.level > 1).map((region) => region.headingId),
  };
}

/** Words of a query, lowercased, for the lexical fallback. */
function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

/** A proposal that has reached a terminal state cannot be resolved again. */
function isResolvedSuggestion(suggestion: SuggestionRecord): boolean {
  return (
    suggestion.status === 'accepted' ||
    suggestion.status === 'rejected' ||
    suggestion.status === 'revised'
  );
}
