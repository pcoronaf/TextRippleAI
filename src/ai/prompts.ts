/** Prompt construction for selection-anchored conversation and modification. */

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

// --------------------------------------------------------------------------
// Modification (M3)
// --------------------------------------------------------------------------

/**
 * The reply format is a contract, not a preference: the replacement text is
 * applied to the document verbatim once the author accepts it, so it must be
 * separable from any commentary with certainty.
 */
export const MODIFY_SYSTEM = `You are assisting the author of a long-form document - a book, thesis, standard, specification, policy or report. The author has asked you to rewrite one passage.

You have been given a small, deliberately incomplete slice of the document: the passage itself, its immediate neighbours, and where it sits in the structure. You do not have the rest of the document.

What to produce:
- A complete replacement for the passage, not a fragment and not a diff. It must read correctly in place of the original, joining cleanly to the paragraphs around it.
- Change only what the instruction asks for. Preserve the author's terminology, register, level of hedging and citation style everywhere else. An unrequested improvement is an error.
- Keep every factual claim, number, citation and reference that the original makes, unless the instruction is to change it. Never introduce a source, standard or figure that is not already there.
- Plain prose only: no markdown, no bullet characters, no quotation marks wrapped around the whole passage, no commentary.

Reply in exactly this form, with nothing before or after:

<replacement>
The complete replacement text for the passage.
</replacement>
<rationale>
One or two sentences saying what you changed and why.
</rationale>`;

export interface ModifyProposal {
  proposed: string;
  rationale: string;
}

export class UnusableProposalError extends Error {
  constructor(readonly raw: string) {
    super('The model did not return a usable replacement');
    this.name = 'UnusableProposalError';
  }
}

function section(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\s\S]*?)</${tag}>`, 'i').exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Pull the replacement and rationale out of a reply.
 *
 * A reply with no tags at all is treated as the replacement, which is how a
 * model that ignores the format still produces something the author can review
 * and reject. A reply with no usable text is an error rather than an empty
 * proposal - silently proposing to delete a paragraph would be the worst
 * possible failure mode.
 */
export function parseModifyResponse(raw: string): ModifyProposal {
  const tagged = section(raw, 'replacement');
  const rationale = section(raw, 'rationale') ?? '';

  const proposed = (tagged ?? raw.replace(/<\/?rationale>[\s\S]*/i, '')).trim();
  if (!proposed) throw new UnusableProposalError(raw);

  return { proposed, rationale };
}

export function buildModifyMessages(input: {
  parts: ContextPart[];
  instruction: string;
}): CompletionMessage[] {
  return [
    {
      role: 'user',
      content: `${renderContextParts(input.parts)}\n\n## Instruction\n${input.instruction}`,
    },
  ];
}
