/**
 * Heuristic change classification.
 *
 * M1 classifies changes with cheap local rules and no LLM call, which is what
 * makes "ignore purely typographical edits" possible in the review interface
 * at zero token cost. M5 refines these categories with the fast model during
 * impact analysis; `factual_assertion` is deliberately not inferred here
 * because no local rule can establish it honestly.
 */

import { diffStats, diffWords } from './diff';
import type { ChangeClassification, ChangeOperation } from './types';

const MODALS = /\b(shall|must|should|may|will|required|prohibited|mandatory|optional)\b/gi;
const DEFINING = /\b(means|is defined as|are defined as|refers to|shall mean|denotes)\b/i;
const CROSS_REFERENCE =
  /(\bsee\b|\bas (?:discussed|described|defined|set out|noted) in\b|§|\b(?:chapter|section|clause|annex|appendix|figure|table)\s*\d)/gi;
const CITATION = /(\[\d+\]|\([A-Z][A-Za-z-]+,?\s*\d{4}\)|\bdoi:\S+|\bISO\/IEC\s*\d+|\bIEEE\s*\d+)/g;
const NUMBER = /\d+(?:[.,]\d+)*\s*%?/g;

/** Collapse the differences that carry no meaning: spacing and typography. */
function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSet(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((value) => value.toLowerCase()).sort();
}

function sameSet(before: string, after: string, pattern: RegExp): boolean {
  return matchSet(before, pattern).join('|') === matchSet(after, pattern).join('|');
}

export interface ClassificationInput {
  blockType: string;
  operation: ChangeOperation;
  before: string;
  after: string;
}

export function classifyChange(input: ClassificationInput): ChangeClassification {
  const { blockType, operation, before, after } = input;

  if (operation === 'move') return 'structural';
  if (blockType === 'heading') return 'structural';
  if (operation === 'insert' || operation === 'delete') {
    // A whole block appearing or disappearing changes the document's shape.
    return 'structural';
  }

  const normBefore = normalizeTypography(before);
  const normAfter = normalizeTypography(after);

  if (normBefore === normAfter) return 'typographical';
  if (normBefore.toLowerCase() === normAfter.toLowerCase()) return 'typographical';

  if (!sameSet(before, after, CITATION)) return 'citation';

  // Checked before the numeric rule: "Chapter 3" becoming "Chapter 4" is a
  // pointer to another part of the document, not a changed quantity.
  if (!sameSet(before, after, CROSS_REFERENCE)) return 'cross_reference';

  // Numbers changed while the surrounding wording held steady.
  if (
    !sameSet(before, after, NUMBER) &&
    normBefore.replace(NUMBER, '#') === normAfter.replace(NUMBER, '#')
  ) {
    return 'numerical_value';
  }

  if (DEFINING.test(normBefore) || DEFINING.test(normAfter)) return 'definition';
  if (!sameSet(before, after, MODALS)) return 'requirement';

  const segments = diffWords(before, after);
  const { inserted, deleted, unchanged } = diffStats(segments);
  const total = inserted + deleted + unchanged;
  const churn = total === 0 ? 1 : (inserted + deleted) / total;

  // A handful of words swapped for a similar handful reads as a wording choice.
  if (inserted > 0 && deleted > 0 && inserted <= 3 && deleted <= 3) return 'terminology';
  if (churn < 0.3) return 'style';

  return 'editorial';
}

/** Changes that carry no meaning downstream and can be filtered from review. */
export function isTrivial(classification: ChangeClassification): boolean {
  return classification === 'typographical';
}

export const CLASSIFICATION_LABELS: Record<ChangeClassification, string> = {
  typographical: 'Typographical',
  editorial: 'Editorial',
  style: 'Style',
  terminology: 'Terminology',
  definition: 'Definition',
  factual_assertion: 'Factual assertion',
  numerical_value: 'Numerical value',
  citation: 'Citation',
  requirement: 'Requirement',
  cross_reference: 'Cross-reference',
  structural: 'Structural',
};
