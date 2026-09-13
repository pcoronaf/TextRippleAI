/**
 * Canonical domain types.
 *
 * These describe the document and change model only. They are deliberately
 * free of any dependency on the editor UI, the storage engine, or an AI
 * provider, so the model can outlive all three.
 */

// --------------------------------------------------------------------------
// Document content (ProseMirror / Tiptap JSON)
// --------------------------------------------------------------------------

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ContentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ContentNode[];
  marks?: Mark[];
  text?: string;
}

export interface DocumentContent extends ContentNode {
  type: 'doc';
  content: ContentNode[];
}

/** A text-bearing block, flattened out of the document tree in reading order. */
export interface FlatBlock {
  id: string;
  type: string;
  text: string;
  /** Ordering hint only - never treat this as identity. */
  position: number;
  parentId: string | null;
  attrs: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Documents
// --------------------------------------------------------------------------

export type DocumentStatus = 'draft' | 'in_review' | 'published';

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  title: string;
  currentRevision: number;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentWithContent {
  document: DocumentRecord;
  content: DocumentContent;
}

export interface DocumentNodeRecord {
  id: string;
  documentId: string;
  parentId: string | null;
  type: string;
  /** Ordering hint only. */
  position: number;
  revision: number;
  text: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  revision: number;
  content: DocumentContent;
  createdAt: string;
  createdBy: string;
}

// --------------------------------------------------------------------------
// Changes
// --------------------------------------------------------------------------

export type ChangeSource = 'human' | 'ai_accepted' | 'import' | 'propagation';

export type ChangeOperation = 'insert' | 'delete' | 'replace' | 'move';

/**
 * Heuristic change categories. M1 assigns these with cheap local rules and no
 * LLM call; M5 refines them with the fast model during impact analysis.
 */
export type ChangeClassification =
  | 'typographical'
  | 'editorial'
  | 'style'
  | 'terminology'
  | 'definition'
  | 'factual_assertion'
  | 'numerical_value'
  | 'citation'
  | 'requirement'
  | 'cross_reference'
  | 'structural';

export type ImpactStatus = 'pending' | 'analyzed' | 'not_applicable';

/** A meaningful change, before it has been written to the ledger. */
export interface DraftChange {
  blockId: string;
  blockType: string;
  operation: ChangeOperation;
  before: string;
  after: string;
  beforeHash: string;
  afterHash: string;
  classification: ChangeClassification;
  sessionId: string;
  occurredAt: string;
}

/** A committed Change Ledger entry. The ledger is append-oriented. */
export interface ChangeRecord extends DraftChange {
  id: string;
  documentId: string;
  authorId: string;
  source: ChangeSource;
  revision: number;
  /** Set when the change is sealed under a checkpoint. */
  checkpointId: string | null;
  impactStatus: ImpactStatus;
  /** Provenance for AI-assisted changes (M3 onwards). */
  prompt: string | null;
  model: string | null;
  suggestionId: string | null;
  createdAt: string;
}

// --------------------------------------------------------------------------
// Checkpoints
// --------------------------------------------------------------------------

export interface CheckpointRecord {
  id: string;
  documentId: string;
  name: string;
  revision: number;
  createdBy: string;
  createdAt: string;
}

/** Summary of what has accumulated since a review boundary. */
export interface ChangesSinceSummary {
  checkpoint: CheckpointRecord | null;
  total: number;
  substantive: number;
  trivial: number;
  byChapter: { chapterId: string | null; title: string; count: number }[];
}

// --------------------------------------------------------------------------
// Conversations (M2)
// --------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant';

/**
 * A conversation is an application object anchored to part of the document,
 * not an ever-growing chat log used as the document's memory. The server
 * rebuilds the context for every turn from the document itself.
 */
export interface ConversationRecord {
  id: string;
  documentId: string;
  /** The block the conversation is anchored to. */
  anchorBlockId: string | null;
  selection: { from: number; to: number } | null;
  selectionText: string;
  title: string;
  relatedChangeId: string | null;
  /** Set when the conversation is about an impact finding. */
  relatedImpactId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One part of the context package assembled for a request. */
export interface ContextPart {
  label: string;
  text: string;
  tokens: number;
}

/**
 * What was actually sent to the model, recorded so the author can inspect it.
 * The spec's "Show AI context" control depends on this being kept.
 */
export interface ContextDigest {
  parts: ContextPart[];
  totalTokens: number;
  /** Estimated tokens in the whole document, for the share-sent metric. */
  documentTokens: number;
  documentPercent: number;
  budgetTokens: number;
  /** Parts omitted because the budget ran out. */
  omitted: string[];
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Present on user turns: the context package that accompanied them. */
  contextDigest: ContextDigest | null;
  createdAt: string;
}

// --------------------------------------------------------------------------
// Suggestions (M3)
// --------------------------------------------------------------------------

/**
 * AI proposals and accepted document edits are separate things. A suggestion is
 * inert: it changes nothing until the author accepts it.
 *
 *   GENERATED ─┬─> REJECTED
 *              ├─> DISCUSSED ──> REVISED   (superseded by a newer proposal)
 *              └─> ACCEPTED ──> document change
 */
export type SuggestionStatus =
  | 'generated'
  | 'discussed'
  | 'revised'
  | 'accepted'
  | 'rejected';

export interface SuggestionRecord {
  id: string;
  documentId: string;
  blockId: string;
  /** The conversation this proposal can be discussed in. */
  conversationId: string | null;
  /** What the author asked for. */
  instruction: string;
  /** The block's text when the proposal was made - the staleness guard. */
  before: string;
  proposed: string;
  rationale: string;
  /** Where the author was highlighting, recorded for provenance only. */
  selectionStart: number | null;
  selectionEnd: number | null;
  status: SuggestionStatus;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  contextDigest: ContextDigest | null;
  /** Set when this proposal supersedes an earlier one. */
  parentSuggestionId: string | null;
  /**
   * The impact finding this proposal exists to resolve.
   *
   * Its presence is what makes the resulting ledger entry a propagation rather
   * than a plain AI edit, and what lets the change be traced back to the change
   * that caused it.
   */
  sourceImpactId: string | null;
  /** Document revision the proposal was generated against. */
  baseRevision: number;
  /** The ledger entry created on acceptance. */
  changeId: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

// --------------------------------------------------------------------------
// Semantic index (M4)
// --------------------------------------------------------------------------

export type SummaryType = 'document' | 'chapter' | 'section';

/**
 * Freshness of a derived artifact.
 *
 * `stale` means the text it describes has changed. `potentially_stale` means
 * something below it changed - a chapter brief whose section moved on is
 * probably still broadly right, and is not worth regenerating until something
 * asks for it. Invalidate cheaply; recompute lazily.
 */
export type IndexStatus = 'current' | 'stale' | 'potentially_stale';

export interface SummaryRecord {
  id: string;
  documentId: string;
  /** The heading this summarises; null for the document brief. */
  nodeId: string | null;
  summaryType: SummaryType;
  content: string;
  /** Document revision the summary was generated from. */
  sourceRevision: number;
  status: IndexStatus;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EmbeddingType = 'block' | 'summary';

export interface EmbeddingRecord {
  id: string;
  documentId: string;
  nodeId: string;
  embeddingType: EmbeddingType;
  vector: number[];
  /** Hash of the text the vector was computed from. */
  contentHash: string;
  sourceRevision: number;
  status: IndexStatus;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticUnitRecord {
  id: string;
  documentId: string;
  nodeId: string;
  unitType: 'term' | 'definition' | 'claim' | 'citation';
  value: string;
  context: string;
  rule: string;
  sourceRevision: number;
  createdAt: string;
}

/** What the index holds and what has gone out of date. */
export interface IndexStatusReport {
  documentId: string;
  revision: number;
  blocks: number;
  embeddings: { current: number; stale: number; missing: number };
  summaries: { type: SummaryType; current: number; stale: number; potentiallyStale: number; missing: number }[];
  semanticUnits: number;
}

/** One retrieval hit, with the signals that produced it. */
export interface RetrievalHit {
  nodeId: string;
  text: string;
  score: number;
  signals: {
    lexicalRank: number | null;
    semanticRank: number | null;
    semanticSimilarity: number | null;
    exactTerm: boolean;
    definition: boolean;
  };
}

// --------------------------------------------------------------------------
// Impact analysis (M5)
// --------------------------------------------------------------------------

export type ImpactAnalysisStatus = 'running' | 'completed' | 'failed';

/**
 * What kind of consequence a change has downstream. These are the categories
 * the reasoning model is asked to choose between; anything it cannot place is
 * reported as `other` rather than forced into a category.
 */
export type ImpactType =
  | 'terminology_consistency'
  | 'definition_conflict'
  | 'contradiction'
  | 'cross_reference'
  | 'numeric_dependency'
  | 'citation'
  | 'scope'
  | 'conclusion_dependency'
  | 'other';

export type ImpactSeverity = 'high' | 'medium' | 'low';

export type RecommendedAction = 'revise' | 'review' | 'no_change';

/**
 * Resolution of one finding.
 *
 *   PENDING ─┬─> DISMISSED            (not a real consequence)
 *            ├─> ACCEPTED_NO_CHANGE   (real, but deliberately left alone)
 *            ├─> NEEDS_REVIEW         (parked for a human pass)
 *            └─> GENERATE_SUGGESTION  (M6 turns it into a proposal)
 */
export type ImpactStatusValue =
  | 'pending'
  | 'dismissed'
  | 'accepted_no_change'
  | 'needs_review'
  | 'generate_suggestion';

export interface ImpactAnalysisRecord {
  id: string;
  documentId: string;
  /** The review boundary the analysis ran from; null means the whole ledger. */
  baseCheckpointId: string | null;
  targetRevision: number;
  status: ImpactAnalysisStatus;
  /** The briefing headline the model wrote. */
  summary: string;
  /** Conceptual changes the ledger entries collapsed into. */
  clusters: {
    id: string;
    label: string;
    classification: ChangeClassification;
    changeIds: string[];
    blockIds: string[];
    size: number;
  }[];
  /** How much of the document reasoning actually looked at. */
  retrieval: {
    blocksInDocument: number;
    candidatesConsidered: number;
    /** Candidates a recorded decision had already settled. */
    suppressedByDecisions?: number;
    /** Share of the document excluded before reasoning. */
    reductionPercent: number;
  };
  changesAnalysed: number;
  changesFiltered: number;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ImpactRecord {
  id: string;
  impactAnalysisId: string;
  documentId: string;
  /** Ledger entries that caused this. */
  sourceChangeIds: string[];
  sourceClusterId: string;
  targetBlockId: string;
  /** Snapshot of the target text when the finding was made. */
  targetText: string;
  impactType: ImpactType;
  confidence: number;
  severity: ImpactSeverity;
  explanation: string;
  recommendedAction: RecommendedAction;
  status: ImpactStatusValue;
  /** Set in M6 when a finding becomes a proposal. */
  suggestionId: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** One retrieved block, with the signals that put it in front of the model. */
export interface ImpactCandidate {
  blockId: string;
  text: string;
  score: number;
  signals: {
    exactTerm: boolean;
    definition: boolean;
    crossReference: boolean;
    citation: boolean;
    numeric: boolean;
    lexicalRank: number | null;
    semanticRank: number | null;
  };
}

// --------------------------------------------------------------------------
// Provenance (M6)
// --------------------------------------------------------------------------

/**
 * Why a paragraph reads the way it does.
 *
 * The chain a propagated edit leaves behind:
 *
 *   change -> suggestion -> impact -> the changes that caused the impact
 *
 * Each hop is an explicit link rather than an inference, so the answer survives
 * everything that happens to the document afterwards.
 */
export interface ChangeProvenance {
  change: ChangeRecord;
  /** The proposal the text came from, for an AI-assisted or propagated change. */
  suggestion: SuggestionRecord | null;
  /** The finding the proposal was written to resolve. */
  impact: ImpactRecord | null;
  /** The analysis that produced that finding. */
  analysis: ImpactAnalysisRecord | null;
  /** The ledger entries whose consequences this change addresses. */
  originChanges: ChangeRecord[];
}

// --------------------------------------------------------------------------
// Decisions (M7)
// --------------------------------------------------------------------------

/**
 * Where a decision holds.
 *
 * `from_node` is the spec's example: a terminology choice taken in Chapter 3
 * that governs the rest of the document but not what precedes it.
 */
export type DecisionScope =
  | { type: 'document'; nodeId?: null }
  | { type: 'node'; nodeId: string }
  | { type: 'from_node'; nodeId: string };

export type DecisionStatus = 'accepted' | 'superseded' | 'retired';

export type DecisionSource = 'manual' | 'conversation' | 'impact_review';

/**
 * Persistent authorial intent.
 *
 * Decisions exist so that reasoning does not disappear inside chat history, and
 * so the system stops proposing something the author has already refused.
 */
export interface DecisionRecord {
  id: string;
  documentId: string;
  title: string;
  description: string;
  scope: DecisionScope;
  status: DecisionStatus;
  source: DecisionSource;
  /**
   * What this decision settles. Narrow on purpose: a decision silences a
   * finding only about the passage and vocabulary it names.
   */
  suppressBlockId: string | null;
  suppressTerms: string[];
  suppressImpactType: string | null;
  /** Where the decision came from, when it came from somewhere. */
  sourceImpactId: string | null;
  sourceConversationId: string | null;
  /** Set on the decision this one replaces. */
  supersedesDecisionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
