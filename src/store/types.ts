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
  EmbeddingRecord,
  EmbeddingType,
  ImpactAnalysisRecord,
  ImpactRecord,
  ImpactSeverity,
  ImpactStatusValue,
  ImpactType,
  IndexStatus,
  IndexStatusReport,
  RecommendedAction,
  MessageRecord,
  MessageRole,
  SemanticUnitRecord,
  SuggestionRecord,
  SuggestionStatus,
  SummaryRecord,
  SummaryType,
} from '@/core/types';
import type { DetectedUnit } from '@/core/semantics';

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

  // ---- Semantic index (M4) ------------------------------------------------
  //
  // Invalidation is not exposed: editing a block marks its own derived
  // artifacts stale as part of the same write that changed it. Nothing may
  // leave the index claiming to be current when it is not.

  listSummaries(
    documentId: string,
    options?: { types?: SummaryType[]; statuses?: IndexStatus[] },
  ): Promise<SummaryRecord[]>;
  upsertSummary(documentId: string, input: SummaryUpsert): Promise<SummaryRecord>;

  listEmbeddings(
    documentId: string,
    options?: { statuses?: IndexStatus[]; nodeIds?: string[] },
  ): Promise<EmbeddingRecord[]>;
  upsertEmbedding(documentId: string, input: EmbeddingUpsert): Promise<EmbeddingRecord>;

  listSemanticUnits(
    documentId: string,
    options?: { nodeIds?: string[]; types?: SemanticUnitRecord['unitType'][] },
  ): Promise<SemanticUnitRecord[]>;
  /** Replace every unit extracted from one block. */
  replaceSemanticUnits(
    documentId: string,
    nodeId: string,
    units: DetectedUnit[],
    sourceRevision: number,
  ): Promise<void>;

  /** Exact-terminology retrieval: full-text search where the engine has it. */
  searchText(documentId: string, query: string, limit: number): Promise<TextHit[]>;
  /** Semantic retrieval over block embeddings. */
  searchVector(documentId: string, vector: number[], limit: number): Promise<VectorHit[]>;

  indexStatus(documentId: string): Promise<IndexStatusReport>;

  // ---- Impact analysis (M5) -----------------------------------------------
  //
  // Findings only. There is no method here that writes document content, which
  // is what makes "impact analysis does not edit the document" structural
  // rather than a promise.

  createImpactAnalysis(
    documentId: string,
    input: CreateImpactAnalysisInput,
  ): Promise<ImpactAnalysisRecord>;
  completeImpactAnalysis(
    documentId: string,
    analysisId: string,
    input: CompleteImpactAnalysisInput,
  ): Promise<ImpactAnalysisRecord>;
  getImpactAnalysis(
    documentId: string,
    analysisId: string,
  ): Promise<{ analysis: ImpactAnalysisRecord; impacts: ImpactRecord[] } | null>;
  listImpactAnalyses(documentId: string): Promise<ImpactAnalysisRecord[]>;

  listImpacts(
    documentId: string,
    options?: { analysisId?: string; statuses?: ImpactStatusValue[] },
  ): Promise<ImpactRecord[]>;
  setImpactStatus(
    documentId: string,
    impactId: string,
    input: { status: ImpactStatusValue; resolvedBy: string; suggestionId?: string | null },
  ): Promise<ImpactRecord>;

  /** Mark ledger entries as having been through analysis. */
  markChangesAnalysed(documentId: string, changeIds: string[]): Promise<void>;
}

export interface CreateImpactAnalysisInput {
  baseCheckpointId: string | null;
  targetRevision: number;
  clusters: ImpactAnalysisRecord['clusters'];
  retrieval: ImpactAnalysisRecord['retrieval'];
  changesAnalysed: number;
  changesFiltered: number;
}

export interface CompleteImpactAnalysisInput {
  status: 'completed' | 'failed';
  summary: string;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  error?: string | null;
  impacts: NewImpact[];
}

export interface NewImpact {
  sourceChangeIds: string[];
  sourceClusterId: string;
  targetBlockId: string;
  targetText: string;
  impactType: ImpactType;
  confidence: number;
  severity: ImpactSeverity;
  explanation: string;
  recommendedAction: RecommendedAction;
}

export class ImpactAnalysisNotFoundError extends Error {
  constructor(readonly analysisId: string) {
    super(`Impact analysis ${analysisId} not found`);
    this.name = 'ImpactAnalysisNotFoundError';
  }
}

export class ImpactNotFoundError extends Error {
  constructor(readonly impactId: string) {
    super(`Impact ${impactId} not found`);
    this.name = 'ImpactNotFoundError';
  }
}

export interface SummaryUpsert {
  nodeId: string | null;
  summaryType: SummaryType;
  content: string;
  sourceRevision: number;
  provider: string | null;
  model: string | null;
}

export interface EmbeddingUpsert {
  nodeId: string;
  embeddingType: EmbeddingType;
  vector: number[];
  contentHash: string;
  sourceRevision: number;
  provider: string | null;
  model: string | null;
}

export interface TextHit {
  nodeId: string;
  text: string;
  rank: number;
}

export interface VectorHit {
  nodeId: string;
  text: string;
  similarity: number;
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
  sourceImpactId?: string | null;
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
  relatedImpactId?: string | null;
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
