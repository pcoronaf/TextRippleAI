/**
 * Storage boundary.
 *
 * The document and change model must not depend on the deployment
 * environment, so every persistence concern lives behind this interface.
 * Two implementations ship: PostgreSQL (the target) and a JSON file store
 * (so the app runs with nothing installed but Node).
 */

import type {
  ChangeRecord,
  ChangeSource,
  CheckpointRecord,
  ContextDigest,
  ConversationRecord,
  DocumentContent,
  DocumentNodeRecord,
  DocumentRecord,
  DocumentWithContent,
  DraftChange,
  MessageRecord,
  MessageRole,
  SuggestionRecord,
  SuggestionStatus,
} from '@/core/types';

export interface CreateDocumentInput {
  title?: string;
  content?: DocumentContent;
  authorId: string;
  workspaceId?: string;
}

export interface SaveDocumentInput {
  content: DocumentContent;
  /** Optimistic concurrency: the revision the client edited from. */
  expectedRevision: number;
  authorId: string;
  /** Meaningful changes produced by the Change Aggregator since the last save. */
  changes: DraftChange[];
  source?: ChangeSource;
  title?: string;
}

export interface SaveDocumentResult {
  document: DocumentRecord;
  changes: ChangeRecord[];
}

export interface ListChangesOptions {
  sinceCheckpointId?: string;
  includeTrivial?: boolean;
  limit?: number;
}

/** Raised when the client's base revision no longer matches the stored one. */
export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Document was modified elsewhere (expected revision ${expected}, found ${actual})`);
    this.name = 'RevisionConflictError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`Document ${documentId} not found`);
    this.name = 'DocumentNotFoundError';
  }
}

export interface Store {
  readonly kind: 'postgres' | 'file';

  listDocuments(): Promise<DocumentRecord[]>;
  createDocument(input: CreateDocumentInput): Promise<DocumentWithContent>;
  getDocument(id: string): Promise<DocumentWithContent | null>;
  saveDocument(id: string, input: SaveDocumentInput): Promise<SaveDocumentResult>;
  deleteDocument(id: string): Promise<void>;

  listNodes(documentId: string): Promise<DocumentNodeRecord[]>;

  listChanges(documentId: string, options?: ListChangesOptions): Promise<ChangeRecord[]>;

  createCheckpoint(
    documentId: string,
    input: { name: string; createdBy: string },
  ): Promise<CheckpointRecord>;
  listCheckpoints(documentId: string): Promise<CheckpointRecord[]>;

  listVersions(documentId: string): Promise<{ revision: number; createdAt: string; createdBy: string }[]>;
  getVersion(documentId: string, revision: number): Promise<DocumentContent | null>;

  // ---- Conversations (M2) -------------------------------------------------
  // `documentId` is carried on every call so a conversation can always be
  // located without a secondary index.

  createConversation(
    documentId: string,
    input: CreateConversationInput,
  ): Promise<ConversationRecord>;
  getConversation(documentId: string, conversationId: string): Promise<ConversationRecord | null>;
  listConversations(
    documentId: string,
    options?: { anchorBlockId?: string },
  ): Promise<ConversationRecord[]>;

  appendMessage(
    documentId: string,
    conversationId: string,
    input: AppendMessageInput,
  ): Promise<MessageRecord>;
  listMessages(documentId: string, conversationId: string): Promise<MessageRecord[]>;

  // ---- Suggestions (M3) ---------------------------------------------------

  createSuggestion(documentId: string, input: CreateSuggestionInput): Promise<SuggestionRecord>;
  getSuggestion(documentId: string, suggestionId: string): Promise<SuggestionRecord | null>;
  listSuggestions(documentId: string, options?: ListSuggestionsOptions): Promise<SuggestionRecord[]>;

  /**
   * Resolve a proposal without touching the document: rejected, or marked as
   * discussed or superseded.
   */
  setSuggestionStatus(
    documentId: string,
    suggestionId: string,
    input: { status: Exclude<SuggestionStatus, 'accepted'>; resolvedBy?: string },
  ): Promise<SuggestionRecord>;

  /**
   * Accept a proposal: apply it to the document, bump the revision, and write
   * the ledger entry that records where the text came from - in one operation,
   * so the document can never disagree with its own provenance.
   */
  acceptSuggestion(
    documentId: string,
    suggestionId: string,
    input: AcceptSuggestionInput,
  ): Promise<AcceptSuggestionResult>;
}

export interface CreateSuggestionInput {
  blockId: string;
  conversationId: string | null;
  instruction: string;
  before: string;
  proposed: string;
  rationale: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  contextDigest: ContextDigest | null;
  parentSuggestionId: string | null;
  baseRevision: number;
}

export interface ListSuggestionsOptions {
  blockId?: string;
  /** Defaults to every status. */
  statuses?: SuggestionStatus[];
}

export interface AcceptSuggestionInput {
  acceptedBy: string;
  /** The revision the author was reviewing against. */
  expectedRevision: number;
}

export interface AcceptSuggestionResult {
  document: DocumentRecord;
  content: DocumentContent;
  change: ChangeRecord;
  suggestion: SuggestionRecord;
}

export class SuggestionNotFoundError extends Error {
  constructor(readonly suggestionId: string) {
    super(`Suggestion ${suggestionId} not found`);
    this.name = 'SuggestionNotFoundError';
  }
}

/** Raised when a proposal is resolved twice. */
export class SuggestionResolvedError extends Error {
  constructor(
    readonly suggestionId: string,
    readonly status: SuggestionStatus,
  ) {
    super(`Suggestion ${suggestionId} was already ${status}`);
    this.name = 'SuggestionResolvedError';
  }
}

/**
 * Raised when the passage has changed since the proposal was made. Applying it
 * anyway would silently discard whatever the author wrote in between.
 */
export class SuggestionStaleError extends Error {
  constructor(readonly suggestionId: string) {
    super(
      `The passage has changed since suggestion ${suggestionId} was proposed. Ask for a fresh rewrite.`,
    );
    this.name = 'SuggestionStaleError';
  }
}

export interface CreateConversationInput {
  anchorBlockId: string | null;
  selection: { from: number; to: number } | null;
  selectionText: string;
  title: string;
}

export interface AppendMessageInput {
  role: MessageRole;
  content: string;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  contextDigest?: ContextDigest | null;
}

export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} not found`);
    this.name = 'ConversationNotFoundError';
  }
}
