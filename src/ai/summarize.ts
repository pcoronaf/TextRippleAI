/**
 * Hierarchical summaries.
 *
 * The point of these is not to describe the document to a reader - it is to let
 * the model reason about document-level context without receiving the whole
 * manuscript. They are written for that job: dense, factual, and about what the
 * text claims rather than what it covers.
 *
 * Target sizes come from the spec's hierarchical memory budget:
 * document ~1,000 tokens, chapter ~400, section ~150.
 */

import type { SummaryType } from '@/core/types';

import { complete } from './gateway';
import type { CompletionResult } from './types';

export const SUMMARY_WORD_TARGETS: Record<SummaryType, number> = {
  section: 110,
  chapter: 300,
  document: 700,
};

const SUMMARY_SYSTEM = `You are building a working index of a long-form document for later machine reasoning, not a blurb for a reader.

Write a brief that says what the text actually asserts: its claims, definitions, requirements, scope and conclusions, in the author's own terminology. Keep the terms the author uses - a brief that paraphrases "human oversight" as "supervision" makes the index worse than useless.

Rules:
- State substance, never coverage. "Defines high-risk systems as those listed in Annex III" - not "discusses definitions".
- Preserve numbers, thresholds, named standards and defined terms exactly.
- No preamble, no headings, no bullet characters. Continuous prose.
- If the text is too thin to summarise, say what little it establishes. Do not pad.`;

function instructionFor(type: SummaryType, title: string, words: number): string {
  const subject =
    type === 'document' ? 'document' : type === 'chapter' ? `chapter "${title}"` : `section "${title}"`;
  return `Write a brief of about ${words} words for the ${subject}.`;
}

export interface SummaryRequest {
  type: SummaryType;
  title: string;
  /** Paragraph text, or the briefs one level down. */
  source: string;
}

export interface GeneratedSummary {
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Summaries are built bottom-up: sections from paragraphs, chapters from their
 * section briefs, the document from its chapter briefs. A chapter brief is
 * therefore a summary of summaries, which is what keeps the token cost of
 * indexing a book proportional to its size rather than quadratic in it.
 *
 * The fast tier is used throughout - this is compression, not judgement.
 */
export async function generateSummary(request: SummaryRequest): Promise<GeneratedSummary> {
  const words = SUMMARY_WORD_TARGETS[request.type];

  const completion: CompletionResult = await complete({
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${instructionFor(request.type, request.title, words)}\n\n---\n${request.source}`,
      },
    ],
    tier: 'fast',
    maxTokens: Math.ceil(words * 3),
  });

  return {
    content: completion.text.trim(),
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
  };
}
