/**
 * Context Builder.
 *
 * The client never decides what the model sees. It sends a document ID, a block
 * ID, a selection and a question; the server assembles the smallest context
 * sufficient to answer, under an explicit token budget.
 *
 * The spec's context package is:
 *
 *     document brief / section title / section brief / previous paragraph /
 *     selected paragraph / next paragraph / relevant decisions / request
 *
 * Every part of that package now exists. What is missing on any given request -
 * an index that has not caught up, a passage no decision covers - is named in
 * the digest rather than silently absent, so a thin answer is legible as
 * missing input rather than as a document with no structure.
 */

import { chapterIndex, flattenBlocks } from '@/core/document';
import type {
  ChangeRecord,
  ContextDigest,
  ContextPart,
  DocumentContent,
  DocumentRecord,
  FlatBlock,
  MessageRecord,
} from '@/core/types';

/** Success metric from the spec: a paragraph-level request stays under this. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 3000;

/** Neighbouring paragraphs are trimmed; the selection itself never is. */
const MAX_NEIGHBOUR_CHARS = 900;
/** Conversation turns replayed on a follow-up. */
const MAX_HISTORY_TURNS = 8;

/**
 * Roughly four characters per token. Good enough to hold a budget; the gateway
 * reports the provider's real count once the request has been made.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()} […]`;
}

function part(label: string, text: string): ContextPart {
  return { label, text, tokens: estimateTokens(text) };
}

export class BlockNotFoundError extends Error {
  constructor(readonly blockId: string) {
    super(`Block ${blockId} is not part of this document`);
    this.name = 'BlockNotFoundError';
  }
}

export interface BuildContextInput {
  document: DocumentRecord;
  content: DocumentContent;
  blockId: string;
  /** The author's selection; falls back to the whole block. */
  selectionText?: string;
  /**
   * What the author had highlighted, when the request covers the whole block
   * anyway (a rewrite). Sent so the model knows where to concentrate.
   */
  highlight?: string;
  question: string;
  /** Ledger entries for this block, newest first. */
  recentChanges?: ChangeRecord[];
  /** Prior turns in this conversation, oldest first. */
  history?: MessageRecord[];
  /**
   * Send the surroundings even though there is conversation history.
   *
   * A follow-up question can lean on what was already said, but a rewrite has
   * to produce text that joins cleanly to the paragraphs on either side, so it
   * needs them in front of it every time.
   */
  resendSurroundings?: boolean;
  /**
   * Hierarchical summaries covering the selection, when the index holds current
   * ones. This is what lets a paragraph-level question be answered with
   * document-level awareness without sending the manuscript.
   */
  briefs?: { document?: string; chapter?: string; section?: string };
  /**
   * Decisions in force for this passage. Persistent authorial intent, so the
   * model does not re-propose something already settled.
   */
  decisions?: { title: string; description: string }[];
  budgetTokens?: number;
}

export interface BuiltContext {
  /** Included parts, in prompt order. */
  parts: ContextPart[];
  digest: ContextDigest;
  /** Turns to replay as messages. */
  history: MessageRecord[];
  selectedText: string;
  block: FlatBlock;
}

interface Candidate {
  label: string;
  text: string;
  /** Lower is kept first when the budget is tight. */
  priority: number;
  /** Included regardless of budget - the request is meaningless without it. */
  required?: boolean;
}

export function buildAskContext(input: BuildContextInput): BuiltContext {
  const blocks = flattenBlocks(input.content);
  const index = blocks.findIndex((block) => block.id === input.blockId);
  if (index === -1) throw new BlockNotFoundError(input.blockId);

  const block = blocks[index];
  const selectedText = input.selectionText?.trim() || block.text;
  const budgetTokens = input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;

  const history = (input.history ?? []).slice(-MAX_HISTORY_TURNS);
  const isFollowUp = history.length > 0 && input.resendSurroundings !== true;

  const candidates: Candidate[] = [
    { label: 'Selected text', text: selectedText, priority: 0, required: true },
  ];

  // On a follow-up the surrounding context is already in the replayed turns.
  // Resending it would pay for the same tokens twice.
  if (!isFollowUp) {
    candidates.push({ label: 'Where this sits', text: locate(input, blocks, index), priority: 1 });

    // Briefs before neighbours: document-level awareness is worth more per
    // token than one more adjacent paragraph.
    const briefs = input.briefs ?? {};
    if (briefs.document?.trim()) {
      candidates.push({ label: 'Document brief', text: briefs.document.trim(), priority: 1 });
    }
    if (briefs.section?.trim()) {
      candidates.push({ label: 'Section brief', text: briefs.section.trim(), priority: 1 });
    }
    if (briefs.chapter?.trim() && briefs.chapter !== briefs.section) {
      candidates.push({ label: 'Chapter brief', text: briefs.chapter.trim(), priority: 2 });
    }

    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    if (previous?.text.trim()) {
      candidates.push({
        label: 'Previous paragraph',
        text: truncate(previous.text, MAX_NEIGHBOUR_CHARS),
        priority: 2,
      });
    }
    if (next?.text.trim()) {
      candidates.push({
        label: 'Next paragraph',
        text: truncate(next.text, MAX_NEIGHBOUR_CHARS),
        priority: 2,
      });
    }

    const highlight = input.highlight?.trim();
    if (highlight && highlight !== selectedText) {
      candidates.push({ label: "The author's highlight", text: highlight, priority: 2 });
    }

    const decisions = (input.decisions ?? [])
      .map((decision) => `- ${decision.title}: ${decision.description}`)
      .join('\n');
    if (decisions.trim()) {
      candidates.push({ label: 'Decisions already taken', text: decisions, priority: 1 });
    }

    const changes = describeChanges(input.recentChanges ?? [], input.blockId);
    if (changes) {
      candidates.push({ label: 'Recent changes to this passage', text: changes, priority: 3 });
    }
  }

  // Select within budget, keeping the required parts whatever happens.
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority);
  const included: ContextPart[] = [];
  const omitted: string[] = [];
  let total = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  for (const candidate of ordered) {
    const tokens = estimateTokens(candidate.text);
    if (!candidate.required && total + tokens > budgetTokens) {
      omitted.push(`${candidate.label} (over the ${budgetTokens}-token budget)`);
      continue;
    }
    included.push(part(candidate.label, candidate.text));
    total += tokens;
  }

  if (isFollowUp) {
    omitted.push('Surrounding context (already present earlier in this conversation)');
  }
  // Named explicitly so a missing brief reads as "the index has not caught up",
  // not as "this document has no structure".
  if (!isFollowUp && !included.some((entry) => entry.label.endsWith('brief'))) {
    omitted.push('Hierarchical summaries (none current in the index yet - refresh it)');
  }
  if (!isFollowUp && !included.some((entry) => entry.label === 'Decisions already taken')) {
    omitted.push('Applicable decisions (none recorded for this passage)');
  }

  const documentTokens = estimateTokens(blocks.map((entry) => entry.text).join(' '));

  const digest: ContextDigest = {
    parts: included,
    totalTokens: total,
    documentTokens,
    documentPercent: documentTokens === 0 ? 0 : Math.round((total / documentTokens) * 1000) / 10,
    budgetTokens,
    omitted,
  };

  // Restore prompt order: the selection reads better after its surroundings.
  const order = [
    'Where this sits',
    'Document brief',
    'Chapter brief',
    'Section brief',
    'Decisions already taken',
    'Previous paragraph',
    'Selected text',
    "The author's highlight",
    'Next paragraph',
    'Recent changes to this passage',
  ];
  const parts = [...included].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));

  return { parts, digest, history, selectedText, block };
}

/** Title and heading path - the structural stand-in for the M4 briefs. */
function locate(input: BuildContextInput, blocks: FlatBlock[], index: number): string {
  const lines = [`Document: ${input.document.title}`];

  const chapter = chapterIndex(input.content).get(input.blockId);
  if (chapter) lines.push(`Chapter: ${chapter.title}`);

  // Nearest preceding heading of any level, which is the section the block is in.
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = blocks[cursor];
    if (candidate.type !== 'heading') continue;
    if (chapter && candidate.id === chapter.id) break;
    lines.push(`Section: ${candidate.text}`);
    break;
  }

  if (blocks[index].type === 'heading') lines.push('The selection is a heading.');

  return lines.join('\n');
}

/** Recent ledger entries for this block, as short before/after lines. */
function describeChanges(changes: ChangeRecord[], blockId: string): string | null {
  const relevant = changes
    .filter((change) => change.blockId === blockId && change.operation === 'replace')
    .slice(0, 3);
  if (relevant.length === 0) return null;

  return relevant
    .map(
      (change) =>
        `- was: "${truncate(change.before, 240)}"\n  now: "${truncate(change.after, 240)}"`,
    )
    .join('\n');
}
