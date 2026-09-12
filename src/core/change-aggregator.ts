/**
 * Change Aggregator.
 *
 * Every editor transaction is observable, but not every keystroke is a
 * meaningful change. This class collapses a stream of low-level edits into the
 * change records that belong in the ledger, grouping by:
 *
 *     same document node + same editing session + short interval
 *
 * Typing "cybersecurity" produces thirteen transactions and exactly one change.
 *
 * It performs no I/O and makes no LLM call - normal editing costs zero tokens.
 * Time is injected so the behaviour is fully testable.
 */

import { classifyChange } from './classify';
import { contentHash } from './hash';
import type { ChangeOperation, DraftChange, FlatBlock } from './types';

export interface AggregatorOptions {
  sessionId: string;
  /** Quiet period after which a block's accumulated edits become a change. */
  idleMs?: number;
  /** Upper bound on how long edits to one block may keep accumulating. */
  maxPendingMs?: number;
}

type PendingKind = 'insert' | 'update' | 'delete';

interface PendingEdit {
  kind: PendingKind;
  blockType: string;
  before: string;
  firstEditAt: number;
  lastEditAt: number;
}

interface BaselineBlock {
  text: string;
  type: string;
}

export const DEFAULT_IDLE_MS = 1500;
export const DEFAULT_MAX_PENDING_MS = 15000;

export class ChangeAggregator {
  private readonly sessionId: string;
  private readonly idleMs: number;
  private readonly maxPendingMs: number;

  /** Last committed state of each block - what a change is measured against. */
  private baseline = new Map<string, BaselineBlock>();
  /** Most recent observation, used when a pending edit is materialised. */
  private current = new Map<string, BaselineBlock>();
  private pending = new Map<string, PendingEdit>();

  constructor(initialBlocks: FlatBlock[], options: AggregatorOptions) {
    this.sessionId = options.sessionId;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxPendingMs = options.maxPendingMs ?? DEFAULT_MAX_PENDING_MS;
    for (const block of initialBlocks) {
      const entry = { text: block.text, type: block.type };
      this.baseline.set(block.id, entry);
      this.current.set(block.id, { ...entry });
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Block IDs with edits not yet written to the ledger. */
  get pendingBlockIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Record the document state after an editor transaction. */
  observe(blocks: FlatBlock[], at: number): void {
    const next = new Map<string, BaselineBlock>(
      blocks.map((block) => [block.id, { text: block.text, type: block.type }]),
    );

    for (const [id, block] of next) {
      const base = this.baseline.get(id);
      const previous = this.current.get(id);
      // Only an edit made in *this* transaction may extend the quiet period.
      // Otherwise typing in one paragraph would hold every other pending edit
      // open indefinitely, and nothing would ever reach the ledger on its own.
      const editedNow = !previous || previous.text !== block.text;

      if (base && base.text === block.text) {
        // Back to where it started (an undo, or a typo typed and removed).
        const existing = this.pending.get(id);
        if (existing && existing.kind === 'update') this.pending.delete(id);
        continue;
      }

      const existing = this.pending.get(id);
      if (existing) {
        if (editedNow) existing.lastEditAt = at;
        continue;
      }

      this.pending.set(id, {
        kind: base ? 'update' : 'insert',
        blockType: base?.type ?? block.type,
        before: base?.text ?? '',
        firstEditAt: at,
        lastEditAt: at,
      });
    }

    for (const [id, base] of this.baseline) {
      if (next.has(id)) continue;
      const existing = this.pending.get(id);
      if (existing) {
        if (existing.kind !== 'delete') {
          existing.kind = 'delete';
          existing.lastEditAt = at;
        }
        continue;
      }
      this.pending.set(id, {
        kind: 'delete',
        blockType: base.type,
        before: base.text,
        firstEditAt: at,
        lastEditAt: at,
      });
    }

    // A block that was inserted and then removed again in the same session
    // leaves nothing behind.
    for (const [id, edit] of this.pending) {
      if (edit.kind === 'insert' && !next.has(id)) this.pending.delete(id);
    }

    this.current = next;
  }

  /** Changes whose quiet period has elapsed. */
  drain(at: number): DraftChange[] {
    return this.materialise(
      at,
      (edit) => at - edit.lastEditAt >= this.idleMs || at - edit.firstEditAt >= this.maxPendingMs,
    );
  }

  /**
   * Every pending change regardless of quiet period. Used when the editor loses
   * focus, the document is saved, or a checkpoint is created - the ledger must
   * never hold a change back across a review boundary.
   */
  drainAll(at: number): DraftChange[] {
    return this.materialise(at, () => true);
  }

  private materialise(at: number, ready: (edit: PendingEdit) => boolean): DraftChange[] {
    const changes: DraftChange[] = [];
    const occurredAt = new Date(at).toISOString();

    for (const [id, edit] of [...this.pending]) {
      if (!ready(edit)) continue;
      this.pending.delete(id);

      const observed = this.current.get(id);
      const after = edit.kind === 'delete' || !observed ? '' : observed.text;
      const before = edit.before;

      if (before === after) {
        this.syncBaseline(id, observed);
        continue;
      }

      const operation: ChangeOperation =
        edit.kind === 'delete' ? 'delete' : edit.kind === 'insert' ? 'insert' : 'replace';
      const blockType = observed?.type ?? edit.blockType;

      changes.push({
        blockId: id,
        blockType,
        operation,
        before,
        after,
        beforeHash: contentHash(before),
        afterHash: contentHash(after),
        classification: classifyChange({ blockType, operation, before, after }),
        sessionId: this.sessionId,
        occurredAt,
      });

      this.syncBaseline(id, observed);
    }

    return changes;
  }

  private syncBaseline(id: string, observed: BaselineBlock | undefined): void {
    if (observed) this.baseline.set(id, { ...observed });
    else this.baseline.delete(id);
  }
}
