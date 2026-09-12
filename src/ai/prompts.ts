/** Prompt construction for selection-anchored conversation. */

import type { ContextPart, MessageRecord } from '@/core/types';

import type { CompletionMessage, ModelTier } from './types';

export type AskAction = 'ask' | 'explain';

export const ASK_SYSTEM = `You are assisting the author of a long-form document - a book, thesis, standard, specification, policy or report.

You have been given a small, deliberately incomplete slice of that document: the passage the author selected, its immediate neighbours, and where it sits in the structure. You do not have the rest of the document, and you should not pretend otherwise.

How to answer:
- Address the author's question about the selected passage. Be specific and brief; two or three short paragraphs at most unless the question demands more.
- Ground every claim in the text you were given. If answering properly would need text you cannot see, say so and name what you would need.
- Do not rewrite the passage unless the author explicitly asks for a rewrite. Proposing a replacement is a separate, deliberate action in this product, and the author has not taken it.
- Do not invent citations, standards, figures or sources.
- Write in the author's register. Skip pleasantries, preamble and summaries of what you are about to say.`;

/** Preset question for the Explain action. */
export const EXPLAIN_QUESTION =
  'Explain what this passage is saying in plain terms, and flag anything in it that is ambiguous, overstated, or does not follow from what precedes it.';

/**
 * Model routing.
 *
 * A question about the author's own argument is judgement work and goes to the
 * reasoning tier. Explaining a passage back is comprehension and goes to the
 * fast tier. Both are overridable by environment.
 */
export function tierFor(action: AskAction): ModelTier {
  return action === 'explain' ? 'fast' : 'reasoning';
}

export function renderContextParts(parts: ContextPart[]): string {
  return parts.map((entry) => `## ${entry.label}\n${entry.text}`).join('\n\n');
}

/**
 * The full prompt for one turn: prior turns replayed as messages, then the
 * context package and the question as the final user turn.
 */
export function buildAskMessages(input: {
  parts: ContextPart[];
  history: MessageRecord[];
  question: string;
}): CompletionMessage[] {
  const messages: CompletionMessage[] = input.history.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  messages.push({
    role: 'user',
    content: `${renderContextParts(input.parts)}\n\n## Question\n${input.question}`,
  });

  return messages;
}

/** A short conversation title derived from the first question. */
export function conversationTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, ' ');
  return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57)}...`;
}
