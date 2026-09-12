/**
 * PostgreSQL store - the deployment target.
 *
 * `pg` is imported lazily so the file store path never pulls it in, and so a
 * build never requires a reachable database.
 */

import type { Pool, PoolClient } from 'pg';

import { replaceBlockText } from '@/core/apply';
import { planInvalidation } from '@/core/index-plan';
import { classifyChange } from '@/core/classify';
import { emptyDocument, ensureNodeIds, flattenBlocks, inferTitle } from '@/core/document';
import { contentHash } from '@/core/hash';
import {
  newChangeId,
  newCheckpointId,
  newConversationId,
  newDocumentId,
  newEmbeddingId,
  newMessageId,
  newSemanticUnitId,
  newSuggestionRecordId,
  newSummaryId,
} from '@/core/ids';
import type {
  ChangeClassification,
  ChangeOperation,
  ChangeRecord,
  ChangeSource,
  CheckpointRecord,
  DocumentContent,
  DocumentNodeRecord,
  DocumentRecord,
  DocumentStatus,
  DocumentWithContent,
  ImpactStatus,
  ConversationRecord,
  MessageRecord,
  MessageRole,
  EmbeddingRecord,
  EmbeddingType,
  IndexStatus,
  IndexStatusReport,
  SemanticUnitRecord,
  SuggestionRecord,
  SuggestionStatus,
  SummaryRecord,
  SummaryType,
} from '@/core/types';
import type { DetectedUnit } from '@/core/semantics';

import { expectedSummaries } from './file-store';
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
  type CreateDocumentInput,
  type CreateSuggestionInput,
  type EmbeddingUpsert,
  type ListChangesOptions,
  type ListSuggestionsOptions,
  type SaveDocumentInput,
  type SaveDocumentResult,
  type Store,
  type SummaryUpsert,
  type TextHit,
  type VectorHit,
} from './types';

type Row = Record<string, any>;

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toDocument(row: Row): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    currentRevision: row.current_revision,
    status: row.status as DocumentStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toNode(row: Row): DocumentNodeRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    parentId: row.parent_id,
    type: row.type,
    position: row.position,
    revision: row.revision,
    text: row.text,
    contentHash: row.content_hash,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toChange(row: Row): ChangeRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    blockId: row.block_id,
    blockType: row.block_type,
    authorId: row.author_id,
    source: row.source as ChangeSource,
    operation: row.operation as ChangeOperation,
    classification: row.classification as ChangeClassification,
    before: row.before_content,
    after: row.after_content,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    sessionId: row.session_id,
    revision: row.revision,
    checkpointId: row.checkpoint_id,
    impactStatus: row.impact_status as ImpactStatus,
    prompt: row.prompt,
    model: row.model,
    suggestionId: row.suggestion_id,
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
  };
}

function toCheckpoint(row: Row): CheckpointRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

function toConversation(row: Row): ConversationRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    anchorBlockId: row.anchor_block_id,
    selection:
      row.selection_from === null || row.selection_to === null
        ? null
        : { from: row.selection_from, to: row.selection_to },
    selectionText: row.selection_text,
    title: row.title,
    relatedChangeId: row.related_change_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toMessage(row: Row): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    contextDigest: row.context_digest ?? null,
    createdAt: toIso(row.created_at),
  };
}

function toSuggestion(row: Row): SuggestionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    blockId: row.block_id,
    conversationId: row.conversation_id,
    instruction: row.instruction,
    before: row.before_content,
    proposed: row.proposed_content,
    rationale: row.rationale,
    selectionStart: row.selection_start,
    selectionEnd: row.selection_end,
    status: row.status as SuggestionStatus,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    contextDigest: row.context_digest ?? null,
    parentSuggestionId: row.parent_suggestion_id,
    baseRevision: row.base_revision,
    changeId: row.change_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
    createdAt: toIso(row.created_at),
  };
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;

  private pool: Promise<Pool> | null = null;

  constructor(private readonly connectionString: string) {}

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = import('pg').then((mod) => {
        const pg = (mod as any).default ?? mod;
        return new pg.Pool({ connectionString: this.connectionString }) as Pool;
      });
    }
    return this.pool;
  }

  private async query<T = Row>(text: string, values: unknown[] = []): Promise<T[]> {
    const pool = await this.getPool();
    const result = await pool.query(text, values as any[]);
    return result.rows as T[];
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    const rows = await this.query(
      `select id, workspace_id, title, current_revision, status, created_at, updated_at
         from documents
        order by updated_at desc`,
    );
    return rows.map(toDocument);
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentWithContent> {
    const id = newDocumentId();
    const { content } = ensureNodeIds(input.content ?? emptyDocument());
    const title = input.title?.trim() || inferTitle(content);

    return this.transaction(async (client) => {
      const inserted = await client.query(
        `insert into documents (id, workspace_id, title, content, current_revision, status)
         values ($1, $2, $3, $4, 1, 'draft')
         returning id, workspace_id, title, current_revision, status, created_at, updated_at`,
        [id, input.workspaceId ?? 'ws_local', title, JSON.stringify(content)],
      );

      await client.query(
        `insert into document_versions (document_id, revision, content, created_by)
         values ($1, 1, $2, $3)`,
        [id, JSON.stringify(content), input.authorId],
      );

      await this.writeNodes(client, id, buildNodeRecords(id, content, 1));

      return { document: toDocument(inserted.rows[0]), content };
    });
  }

  private async writeNodes(
    client: PoolClient,
    documentId: string,
    nodes: DocumentNodeRecord[],
  ): Promise<void> {
    for (const node of nodes) {
      await client.query(
        `insert into document_nodes
             (id, document_id, parent_id, type, position, revision, text, content_hash, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (document_id, id) do update
             set parent_id    = excluded.parent_id,
                 type         = excluded.type,
                 position     = excluded.position,
                 revision     = excluded.revision,
                 text         = excluded.text,
                 content_hash = excluded.content_hash,
                 updated_at   = excluded.updated_at`,
        [
          node.id,
          documentId,
          node.parentId,
          node.type,
          node.position,
          node.revision,
          node.text,
          node.contentHash,
          node.createdAt,
          node.updatedAt,
        ],
      );
    }

    const surviving = nodes.map((node) => node.id);
    await client.query(
      `delete from document_nodes
        where document_id = $1
          and not (id = any ($2::text[]))`,
      [documentId, surviving],
    );
  }

  async getDocument(id: string): Promise<DocumentWithContent | null> {
    const rows = await this.query(
      `select id, workspace_id, title, content, current_revision, status, created_at, updated_at
         from documents
        where id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return { document: toDocument(rows[0]), content: rows[0].content as DocumentContent };
  }

  async saveDocument(id: string, input: SaveDocumentInput): Promise<SaveDocumentResult> {
    const { content } = ensureNodeIds(input.content);

    return this.transaction(async (client) => {
      const locked = await client.query(
        `select id, workspace_id, title, current_revision, status, created_at, updated_at
           from documents
          where id = $1
          for update`,
        [id],
      );
      if (locked.rows.length === 0) throw new DocumentNotFoundError(id);

      const currentRevision: number = locked.rows[0].current_revision;
      if (currentRevision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, currentRevision);
      }

      const revision = currentRevision + 1;
      const title = input.title?.trim() || inferTitle(content, locked.rows[0].title);

      const updated = await client.query(
        `update documents
            set content          = $2,
                title            = $3,
                current_revision = $4,
                updated_at       = now()
          where id = $1
          returning id, workspace_id, title, current_revision, status, created_at, updated_at`,
        [id, JSON.stringify(content), title, revision],
      );

      await client.query(
        `insert into document_versions (document_id, revision, content, created_by)
         values ($1, $2, $3, $4)`,
        [id, revision, JSON.stringify(content), input.authorId],
      );

      const existing = await client.query(
        `select id, document_id, parent_id, type, position, revision, text, content_hash, created_at, updated_at
           from document_nodes
          where document_id = $1`,
        [id],
      );
      const previousNodes = existing.rows.map(toNode);
      const nodes = buildNodeRecords(id, content, revision, previousNodes);
      await this.writeNodes(client, id, nodes);

      const surviving = new Set(nodes.map((node) => node.id));
      await this.invalidateIndex(
        client,
        id,
        content,
        nodes.filter((node) => node.revision === revision).map((node) => node.id),
        previousNodes.filter((node) => !surviving.has(node.id)).map((node) => node.id),
      );

      const changes = toChangeRecords(id, input.changes, {
        authorId: input.authorId,
        source: input.source ?? 'human',
        revision,
      });

      for (const change of changes) {
        await client.query(
          `insert into changes
               (id, document_id, block_id, block_type, author_id, source, operation, classification,
                before_content, after_content, before_hash, after_hash, session_id, revision,
                checkpoint_id, impact_status, prompt, model, suggestion_id, occurred_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
          [
            change.id,
            change.documentId,
            change.blockId,
            change.blockType,
            change.authorId,
            change.source,
            change.operation,
            change.classification,
            change.before,
            change.after,
            change.beforeHash,
            change.afterHash,
            change.sessionId,
            change.revision,
            change.checkpointId,
            change.impactStatus,
            change.prompt,
            change.model,
            change.suggestionId,
            change.occurredAt,
            change.createdAt,
          ],
        );
      }

      return { document: toDocument(updated.rows[0]), changes };
    });
  }

  async deleteDocument(id: string): Promise<void> {
    await this.query('delete from documents where id = $1', [id]);
  }

  async listNodes(documentId: string): Promise<DocumentNodeRecord[]> {
    const rows = await this.query(
      `select id, document_id, parent_id, type, position, revision, text, content_hash, created_at, updated_at
         from document_nodes
        where document_id = $1
        order by position asc`,
      [documentId],
    );
    return rows.map(toNode);
  }

  async listChanges(documentId: string, options: ListChangesOptions = {}): Promise<ChangeRecord[]> {
    const conditions = ['c.document_id = $1'];
    const values: unknown[] = [documentId];

    if (options.sinceCheckpointId) {
      values.push(options.sinceCheckpointId);
      conditions.push(
        `c.revision > coalesce((select revision from checkpoints where id = $${values.length}), 0)`,
      );
    }
    if (options.includeTrivial === false) {
      values.push('typographical');
      conditions.push(`c.classification <> $${values.length}`);
    }

    let sql = `select c.* from changes c
                where ${conditions.join(' and ')}
                order by c.revision desc, c.created_at desc`;
    if (options.limit) {
      values.push(options.limit);
      sql += ` limit $${values.length}`;
    }

    const rows = await this.query(sql, values);
    return rows.map(toChange);
  }

  async createCheckpoint(
    documentId: string,
    input: { name: string; createdBy: string },
  ): Promise<CheckpointRecord> {
    return this.transaction(async (client) => {
      const document = await client.query(
        'select current_revision from documents where id = $1 for update',
        [documentId],
      );
      if (document.rows.length === 0) throw new DocumentNotFoundError(documentId);

      const revision: number = document.rows[0].current_revision;
      const id = newCheckpointId();
      const name = input.name.trim() || `Checkpoint at revision ${revision}`;

      const inserted = await client.query(
        `insert into checkpoints (id, document_id, name, revision, created_by)
         values ($1, $2, $3, $4, $5)
         returning id, document_id, name, revision, created_by, created_at`,
        [id, documentId, name, revision, input.createdBy],
      );

      // Seal every change that has accumulated since the previous checkpoint.
      await client.query(
        `update changes set checkpoint_id = $1
          where document_id = $2 and checkpoint_id is null`,
        [id, documentId],
      );

      return toCheckpoint(inserted.rows[0]);
    });
  }

  async listCheckpoints(documentId: string): Promise<CheckpointRecord[]> {
    const rows = await this.query(
      `select id, document_id, name, revision, created_by, created_at
         from checkpoints
        where document_id = $1
        order by revision desc, created_at desc`,
      [documentId],
    );
    return rows.map(toCheckpoint);
  }

  async listVersions(
    documentId: string,
  ): Promise<{ revision: number; createdAt: string; createdBy: string }[]> {
    const rows = await this.query(
      `select revision, created_at, created_by
         from document_versions
        where document_id = $1
        order by revision desc`,
      [documentId],
    );
    return rows.map((row) => ({
      revision: row.revision,
      createdAt: toIso(row.created_at),
      createdBy: row.created_by,
    }));
  }

  async getVersion(documentId: string, revision: number): Promise<DocumentContent | null> {
    const rows = await this.query(
      'select content from document_versions where document_id = $1 and revision = $2',
      [documentId, revision],
    );
    return rows.length > 0 ? (rows[0].content as DocumentContent) : null;
  }

  // ---- Conversations ------------------------------------------------------

  async createConversation(
    documentId: string,
    input: CreateConversationInput,
  ): Promise<ConversationRecord> {
    const rows = await this.query(
      `insert into conversations
           (id, document_id, anchor_block_id, selection_from, selection_to, selection_text, title)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        newConversationId(),
        documentId,
        input.anchorBlockId,
        input.selection?.from ?? null,
        input.selection?.to ?? null,
        input.selectionText,
        input.title,
      ],
    );
    return toConversation(rows[0]);
  }

  async getConversation(
    documentId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    const rows = await this.query(
      'select * from conversations where document_id = $1 and id = $2',
      [documentId, conversationId],
    );
    return rows.length > 0 ? toConversation(rows[0]) : null;
  }

  async listConversations(
    documentId: string,
    options: { anchorBlockId?: string } = {},
  ): Promise<ConversationRecord[]> {
    const values: unknown[] = [documentId];
    let sql = 'select * from conversations where document_id = $1';

    if (options.anchorBlockId) {
      values.push(options.anchorBlockId);
      sql += ` and anchor_block_id = $${values.length}`;
    }
    sql += ' order by updated_at desc';

    return (await this.query(sql, values)).map(toConversation);
  }

  async appendMessage(
    documentId: string,
    conversationId: string,
    input: AppendMessageInput,
  ): Promise<MessageRecord> {
    return this.transaction(async (client) => {
      const owner = await client.query(
        'select id from conversations where document_id = $1 and id = $2 for update',
        [documentId, conversationId],
      );
      if (owner.rows.length === 0) throw new ConversationNotFoundError(conversationId);

      const inserted = await client.query(
        `insert into messages
             (id, conversation_id, role, content, provider, model, input_tokens, output_tokens, context_digest)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          newMessageId(),
          conversationId,
          input.role,
          input.content,
          input.provider ?? null,
          input.model ?? null,
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          input.contextDigest ? JSON.stringify(input.contextDigest) : null,
        ],
      );

      await client.query('update conversations set updated_at = now() where id = $1', [
        conversationId,
      ]);

      return toMessage(inserted.rows[0]);
    });
  }

  async listMessages(documentId: string, conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.query(
      `select m.*
         from messages m
         join conversations c on c.id = m.conversation_id
        where c.document_id = $1 and m.conversation_id = $2
        order by m.created_at asc, m.id asc`,
      [documentId, conversationId],
    );
    return rows.map(toMessage);
  }

  // ---- Suggestions --------------------------------------------------------

  async createSuggestion(
    documentId: string,
    input: CreateSuggestionInput,
  ): Promise<SuggestionRecord> {
    const rows = await this.query(
      `insert into suggestions
           (id, document_id, block_id, conversation_id, instruction, before_content,
            proposed_content, rationale, selection_start, selection_end, status,
            provider, model, input_tokens, output_tokens, context_digest,
            parent_suggestion_id, base_revision)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'generated', $11, $12, $13, $14, $15, $16, $17)
       returning *`,
      [
        newSuggestionRecordId(),
        documentId,
        input.blockId,
        input.conversationId,
        input.instruction,
        input.before,
        input.proposed,
        input.rationale,
        input.selectionStart,
        input.selectionEnd,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.contextDigest ? JSON.stringify(input.contextDigest) : null,
        input.parentSuggestionId,
        input.baseRevision,
      ],
    );
    return toSuggestion(rows[0]);
  }

  async getSuggestion(documentId: string, suggestionId: string): Promise<SuggestionRecord | null> {
    const rows = await this.query(
      'select * from suggestions where document_id = $1 and id = $2',
      [documentId, suggestionId],
    );
    return rows.length > 0 ? toSuggestion(rows[0]) : null;
  }

  async listSuggestions(
    documentId: string,
    options: ListSuggestionsOptions = {},
  ): Promise<SuggestionRecord[]> {
    const values: unknown[] = [documentId];
    let sql = 'select * from suggestions where document_id = $1';

    if (options.blockId) {
      values.push(options.blockId);
      sql += ` and block_id = $${values.length}`;
    }
    if (options.statuses?.length) {
      values.push(options.statuses);
      sql += ` and status = any ($${values.length}::text[])`;
    }
    sql += ' order by created_at desc';

    return (await this.query(sql, values)).map(toSuggestion);
  }

  async setSuggestionStatus(
    documentId: string,
    suggestionId: string,
    input: { status: Exclude<SuggestionStatus, 'accepted'>; resolvedBy?: string },
  ): Promise<SuggestionRecord> {
    return this.transaction(async (client) => {
      const current = await client.query(
        'select * from suggestions where document_id = $1 and id = $2 for update',
        [documentId, suggestionId],
      );
      if (current.rows.length === 0) throw new SuggestionNotFoundError(suggestionId);

      const status = current.rows[0].status as SuggestionStatus;
      if (isResolved(status)) throw new SuggestionResolvedError(suggestionId, status);

      const terminal = input.status === 'rejected' || input.status === 'revised';
      const updated = await client.query(
        `update suggestions
            set status      = $3,
                resolved_by = case when $4::boolean then $5 else resolved_by end,
                resolved_at = case when $4::boolean then now() else resolved_at end
          where document_id = $1 and id = $2
          returning *`,
        [documentId, suggestionId, input.status, terminal, input.resolvedBy ?? null],
      );

      return toSuggestion(updated.rows[0]);
    });
  }

  async acceptSuggestion(
    documentId: string,
    suggestionId: string,
    input: AcceptSuggestionInput,
  ): Promise<AcceptSuggestionResult> {
    return this.transaction(async (client) => {
      const locked = await client.query(
        `select d.id, d.workspace_id, d.title, d.content, d.current_revision, d.status,
                d.created_at, d.updated_at
           from documents d
          where d.id = $1
          for update`,
        [documentId],
      );
      if (locked.rows.length === 0) throw new DocumentNotFoundError(documentId);

      const found = await client.query(
        'select * from suggestions where document_id = $1 and id = $2 for update',
        [documentId, suggestionId],
      );
      if (found.rows.length === 0) throw new SuggestionNotFoundError(suggestionId);

      const suggestion = toSuggestion(found.rows[0]);
      if (isResolved(suggestion.status)) {
        throw new SuggestionResolvedError(suggestionId, suggestion.status);
      }

      const currentRevision: number = locked.rows[0].current_revision;
      if (currentRevision !== input.expectedRevision) {
        throw new RevisionConflictError(input.expectedRevision, currentRevision);
      }

      const currentContent = locked.rows[0].content as DocumentContent;
      const block = flattenBlocks(currentContent).find((entry) => entry.id === suggestion.blockId);
      if (!block || block.text !== suggestion.before) {
        throw new SuggestionStaleError(suggestionId);
      }

      const revision = currentRevision + 1;
      const { content } = ensureNodeIds(
        replaceBlockText(currentContent, suggestion.blockId, suggestion.proposed),
      );
      const title = inferTitle(content, locked.rows[0].title);

      const updatedDocument = await client.query(
        `update documents
            set content = $2, title = $3, current_revision = $4, updated_at = now()
          where id = $1
          returning id, workspace_id, title, current_revision, status, created_at, updated_at`,
        [documentId, JSON.stringify(content), title, revision],
      );

      await client.query(
        `insert into document_versions (document_id, revision, content, created_by)
         values ($1, $2, $3, $4)`,
        [documentId, revision, JSON.stringify(content), input.acceptedBy],
      );

      const existingNodes = await client.query(
        `select id, document_id, parent_id, type, position, revision, text, content_hash,
                created_at, updated_at
           from document_nodes where document_id = $1`,
        [documentId],
      );
      await this.writeNodes(
        client,
        documentId,
        buildNodeRecords(documentId, content, revision, existingNodes.rows.map(toNode)),
      );

      const changeId = newChangeId();
      const model = suggestion.model
        ? `${suggestion.provider ?? 'unknown'}:${suggestion.model}`
        : null;

      const insertedChange = await client.query(
        `insert into changes
             (id, document_id, block_id, block_type, author_id, source, operation, classification,
              before_content, after_content, before_hash, after_hash, session_id, revision,
              checkpoint_id, impact_status, prompt, model, suggestion_id, occurred_at, created_at)
         values ($1, $2, $3, $4, $5, 'ai_accepted', 'replace', $6, $7, $8, $9, $10, $11, $12,
                 null, 'pending', $13, $14, $15, now(), now())
         returning *`,
        [
          changeId,
          documentId,
          suggestion.blockId,
          block.type,
          input.acceptedBy,
          classifyChange({
            blockType: block.type,
            operation: 'replace',
            before: block.text,
            after: suggestion.proposed,
          }),
          block.text,
          suggestion.proposed,
          contentHash(block.text),
          contentHash(suggestion.proposed),
          // For an accepted proposal the "session" is the conversation it came
          // out of, which is what someone tracing the edit would want next.
          suggestion.conversationId ?? suggestionId,
          revision,
          suggestion.instruction,
          model,
          suggestionId,
        ],
      );

      const accepted = await client.query(
        `update suggestions
            set status = 'accepted', change_id = $3, resolved_by = $4, resolved_at = now()
          where document_id = $1 and id = $2
          returning *`,
        [documentId, suggestionId, changeId, input.acceptedBy],
      );

      await this.invalidateIndex(client, documentId, content, [suggestion.blockId], []);

      return {
        document: toDocument(updatedDocument.rows[0]),
        content,
        change: toChange(insertedChange.rows[0]),
        suggestion: toSuggestion(accepted.rows[0]),
      };
    });
  }

  // ---- Semantic index -----------------------------------------------------

  /**
   * Mark derived artifacts stale in the same transaction that moved the text,
   * and drop those belonging to blocks that no longer exist.
   */
  private async invalidateIndex(
    client: PoolClient,
    documentId: string,
    content: DocumentContent,
    changedNodeIds: string[],
    removedNodeIds: string[],
  ): Promise<void> {
    if (removedNodeIds.length > 0) {
      await client.query(
        'delete from embeddings where document_id = $1 and node_id = any ($2::text[])',
        [documentId, removedNodeIds],
      );
      await client.query(
        'delete from semantic_units where document_id = $1 and node_id = any ($2::text[])',
        [documentId, removedNodeIds],
      );
      await client.query(
        'delete from summaries where document_id = $1 and node_id = any ($2::text[])',
        [documentId, removedNodeIds],
      );
    }

    if (changedNodeIds.length === 0) return;
    const plan = planInvalidation(content, changedNodeIds);

    await client.query(
      `update embeddings set status = 'stale', updated_at = now()
        where document_id = $1 and node_id = any ($2::text[])`,
      [documentId, plan.staleBlockIds],
    );

    if (plan.staleSummaryNodeIds.length > 0) {
      await client.query(
        `update summaries set status = 'stale', updated_at = now()
          where document_id = $1 and node_id = any ($2::text[])`,
        [documentId, plan.staleSummaryNodeIds],
      );
    }
    if (plan.potentiallyStaleSummaryNodeIds.length > 0) {
      await client.query(
        `update summaries set status = 'potentially_stale', updated_at = now()
          where document_id = $1 and node_id = any ($2::text[]) and status = 'current'`,
        [documentId, plan.potentiallyStaleSummaryNodeIds],
      );
    }
    if (plan.documentSummaryAffected) {
      await client.query(
        `update summaries set status = 'potentially_stale', updated_at = now()
          where document_id = $1 and node_id is null and status = 'current'`,
        [documentId],
      );
    }
  }

  async listSummaries(
    documentId: string,
    options: { types?: SummaryType[]; statuses?: IndexStatus[] } = {},
  ): Promise<SummaryRecord[]> {
    const values: unknown[] = [documentId];
    let sql = 'select * from summaries where document_id = $1';

    if (options.types?.length) {
      values.push(options.types);
      sql += ` and summary_type = any ($${values.length}::text[])`;
    }
    if (options.statuses?.length) {
      values.push(options.statuses);
      sql += ` and status = any ($${values.length}::text[])`;
    }

    return (await this.query(sql, values)).map(toSummary);
  }

  async upsertSummary(documentId: string, input: SummaryUpsert): Promise<SummaryRecord> {
    // The unique indexes are partial (node_id null vs not null), so `on
    // conflict` cannot target them; update first and insert when nothing moved.
    const updated = await this.query(
      `update summaries
          set content = $4, source_revision = $5, status = 'current',
              provider = $6, model = $7, updated_at = now()
        where document_id = $1 and summary_type = $2
          and node_id is not distinct from $3
        returning *`,
      [
        documentId,
        input.summaryType,
        input.nodeId,
        input.content,
        input.sourceRevision,
        input.provider,
        input.model,
      ],
    );
    if (updated.length > 0) return toSummary(updated[0]);

    const inserted = await this.query(
      `insert into summaries
           (id, document_id, node_id, summary_type, content, source_revision, status, provider, model)
       values ($1, $2, $3, $4, $5, $6, 'current', $7, $8)
       returning *`,
      [
        newSummaryId(),
        documentId,
        input.nodeId,
        input.summaryType,
        input.content,
        input.sourceRevision,
        input.provider,
        input.model,
      ],
    );
    return toSummary(inserted[0]);
  }

  async listEmbeddings(
    documentId: string,
    options: { statuses?: IndexStatus[]; nodeIds?: string[] } = {},
  ): Promise<EmbeddingRecord[]> {
    const values: unknown[] = [documentId];
    let sql = 'select * from embeddings where document_id = $1';

    if (options.statuses?.length) {
      values.push(options.statuses);
      sql += ` and status = any ($${values.length}::text[])`;
    }
    if (options.nodeIds?.length) {
      values.push(options.nodeIds);
      sql += ` and node_id = any ($${values.length}::text[])`;
    }

    return (await this.query(sql, values)).map(toEmbedding);
  }

  async upsertEmbedding(documentId: string, input: EmbeddingUpsert): Promise<EmbeddingRecord> {
    const rows = await this.query(
      `insert into embeddings
           (id, document_id, node_id, embedding_type, vector, content_hash, source_revision,
            status, provider, model)
       values ($1, $2, $3, $4, $5::vector, $6, $7, 'current', $8, $9)
       on conflict (document_id, node_id, embedding_type) do update
           set vector          = excluded.vector,
               content_hash    = excluded.content_hash,
               source_revision = excluded.source_revision,
               status          = 'current',
               provider        = excluded.provider,
               model           = excluded.model,
               updated_at      = now()
       returning *`,
      [
        newEmbeddingId(),
        documentId,
        input.nodeId,
        input.embeddingType,
        toVectorLiteral(input.vector),
        input.contentHash,
        input.sourceRevision,
        input.provider,
        input.model,
      ],
    );
    return toEmbedding(rows[0]);
  }

  async listSemanticUnits(
    documentId: string,
    options: { nodeIds?: string[]; types?: SemanticUnitRecord['unitType'][] } = {},
  ): Promise<SemanticUnitRecord[]> {
    const values: unknown[] = [documentId];
    let sql = 'select * from semantic_units where document_id = $1';

    if (options.nodeIds?.length) {
      values.push(options.nodeIds);
      sql += ` and node_id = any ($${values.length}::text[])`;
    }
    if (options.types?.length) {
      values.push(options.types);
      sql += ` and unit_type = any ($${values.length}::text[])`;
    }

    return (await this.query(sql, values)).map(toSemanticUnit);
  }

  async replaceSemanticUnits(
    documentId: string,
    nodeId: string,
    units: DetectedUnit[],
    sourceRevision: number,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('delete from semantic_units where document_id = $1 and node_id = $2', [
        documentId,
        nodeId,
      ]);

      for (const unit of units) {
        await client.query(
          `insert into semantic_units
               (id, document_id, node_id, unit_type, value, context, rule, source_revision)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newSemanticUnitId(),
            documentId,
            nodeId,
            unit.type,
            unit.value,
            unit.context,
            unit.rule,
            sourceRevision,
          ],
        );
      }
    });
  }

  /** Exact-terminology retrieval over the full-text index from migration 0001. */
  async searchText(documentId: string, query: string, limit: number): Promise<TextHit[]> {
    const rows = await this.query(
      `select id as node_id, text,
              ts_rank(to_tsvector('english', text), plainto_tsquery('english', $2)) as rank
         from document_nodes
        where document_id = $1
          and to_tsvector('english', text) @@ plainto_tsquery('english', $2)
        order by rank desc
        limit $3`,
      [documentId, query, limit],
    );

    return rows.map((row) => ({
      nodeId: row.node_id,
      text: row.text,
      rank: Number(row.rank),
    }));
  }

  /** Semantic retrieval: cosine distance over pgvector. */
  async searchVector(documentId: string, vector: number[], limit: number): Promise<VectorHit[]> {
    const rows = await this.query(
      `select e.node_id, n.text, 1 - (e.vector <=> $2::vector) as similarity
         from embeddings e
         join document_nodes n
           on n.document_id = e.document_id and n.id = e.node_id
        where e.document_id = $1 and e.embedding_type = 'block'
        order by e.vector <=> $2::vector
        limit $3`,
      [documentId, toVectorLiteral(vector), limit],
    );

    return rows.map((row) => ({
      nodeId: row.node_id,
      text: row.text,
      similarity: Number(row.similarity),
    }));
  }

  async indexStatus(documentId: string): Promise<IndexStatusReport> {
    const document = await this.getDocument(documentId);
    if (!document) throw new DocumentNotFoundError(documentId);

    const blocks = flattenBlocks(document.content);
    const [embeddings, summaries, units] = await Promise.all([
      this.listEmbeddings(documentId),
      this.listSummaries(documentId),
      this.query('select count(*)::int as count from semantic_units where document_id = $1', [
        documentId,
      ]),
    ]);

    const embedded = new Set(embeddings.map((entry) => entry.nodeId));
    const expected = expectedSummaries(document.content);

    return {
      documentId,
      revision: document.document.currentRevision,
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
      semanticUnits: units[0]?.count ?? 0,
    };
  }
}

/** A proposal that has reached a terminal state cannot be resolved again. */
function isResolved(status: SuggestionStatus): boolean {
  return status === 'accepted' || status === 'rejected' || status === 'revised';
}

function toSummary(row: Row): SummaryRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    nodeId: row.node_id,
    summaryType: row.summary_type as SummaryType,
    content: row.content,
    sourceRevision: row.source_revision,
    status: row.status as IndexStatus,
    provider: row.provider,
    model: row.model,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** pgvector returns its type as the string "[1,2,3]". */
function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number);
}

const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;

function toEmbedding(row: Row): EmbeddingRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    nodeId: row.node_id,
    embeddingType: row.embedding_type as EmbeddingType,
    vector: parseVector(row.vector),
    contentHash: row.content_hash,
    sourceRevision: row.source_revision,
    status: row.status as IndexStatus,
    provider: row.provider,
    model: row.model,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toSemanticUnit(row: Row): SemanticUnitRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    nodeId: row.node_id,
    unitType: row.unit_type,
    value: row.value,
    context: row.context,
    rule: row.rule,
    sourceRevision: row.source_revision,
    createdAt: toIso(row.created_at),
  };
}
