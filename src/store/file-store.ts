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
import { emptyDocument, ensureNodeIds, flattenBlocks, inferTitle } from '@/core/document';
import { contentHash } from '@/core/hash';
import {
  newChangeId,
  newCheckpointId,
  newConversationId,
  newDocumentId,
  newMessageId,
  newSuggestionRecordId,
} from '@/core/ids';
import { classifyChange, isTrivial } from '@/core/classify';
import type {
  ChangeRecord,
  CheckpointRecord,
  ConversationRecord,
  DocumentContent,
  DocumentNodeRecord,
  DocumentRecord,
  DocumentWithContent,
  MessageRecord,
  SuggestionRecord,
} from '@/core/types';

import { buildNodeRecords, toChangeRecords } from './records';
import {
  ConversationNotFoundError,
  DocumentNotFoundError,
  RevisionConflictError,
  SuggestionNotFoundError,
  SuggestionResolvedError,
  SuggestionStaleError,
  type AcceptSuggestionInput,
  type AcceptSuggestionResult,
  type AppendMessageInput,
  type CreateConversationInput,
  type CreateSuggestionInput,
  type CreateDocumentInput,
  type ListChangesOptions,
  type ListSuggestionsOptions,
  type SaveDocumentInput,
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
  // Added in M2/M3; files written before then will not carry these.
  conversations?: ConversationRecord[];
  messages?: MessageRecord[];
  suggestions?: SuggestionRecord[];
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

      await this.write({
        ...data,
        document,
        content,
        nodes: buildNodeRecords(id, content, revision, data.nodes),
        changes: [...data.changes, ...changes],
        checkpoints: data.checkpoints,
        versions: retained,
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
      if (isResolved(current)) throw new SuggestionResolvedError(suggestionId, current.status);

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
      if (isResolved(suggestion)) throw new SuggestionResolvedError(suggestionId, suggestion.status);

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
        source: 'ai_accepted',
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

      await this.write({
        ...data,
        document,
        content,
        nodes: buildNodeRecords(documentId, content, revision, data.nodes),
        changes: [...data.changes, change],
        versions: retained,
        suggestions: suggestions.map((entry) => (entry.id === suggestionId ? accepted : entry)),
      });

      return { document, content, change, suggestion: accepted };
    });
  }
}

/** A proposal that has reached a terminal state cannot be resolved again. */
function isResolved(suggestion: SuggestionRecord): boolean {
  return (
    suggestion.status === 'accepted' ||
    suggestion.status === 'rejected' ||
    suggestion.status === 'revised'
  );
}
