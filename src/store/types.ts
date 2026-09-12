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
  DocumentContent,
  DocumentNodeRecord,
  DocumentRecord,
  DocumentWithContent,
  DraftChange,
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
}
