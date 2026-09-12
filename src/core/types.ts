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
