/**
 * Decision memory.
 *
 * A decision is persistent authorial intent: the reasoning behind a choice,
 * kept where the system can find it rather than buried in a conversation that
 * nobody will scroll back through. Its job is to stop the same question being
 * asked twice - and, specifically, to stop impact analysis proposing again
 * something the author has already refused.
 *
 * Everything here is local and free: scope matching, relevance, and conflict
 * detection between decisions.
 */

import type { DecisionRecord, DecisionScope, FlatBlock } from './types';

/**
 * Does a decision apply to a block?
 *
 *   document  - everywhere
 *   node      - that node, or a block inside the region it heads
 *   from_node - that node and everything after it in reading order
 *
 * `from_node` is the spec's example: a terminology choice taken in Chapter 3
 * that governs the rest of the document but not what precedes it.
 */
export function decisionApplies(
  scope: DecisionScope,
  blockId: string,
  blocks: readonly FlatBlock[],
  enclosing: ReadonlyMap<string, { sectionId: string | null; chapterId: string | null }>,
): boolean {
  if (scope.type === 'document') return true;
  if (!scope.nodeId) return false;

  if (scope.type === 'node') {
    if (blockId === scope.nodeId) return true;
    const parents = enclosing.get(blockId);
    return parents?.sectionId === scope.nodeId || parents?.chapterId === scope.nodeId;
  }

  // from_node: position in reading order decides.
  const anchor = blocks.findIndex((block) => block.id === scope.nodeId);
  const target = blocks.findIndex((block) => block.id === blockId);
  if (anchor === -1 || target === -1) return false;
  return target >= anchor;
}

/** Decisions in force for a block: accepted only, never superseded or retired. */
export function decisionsFor(
  decisions: readonly DecisionRecord[],
  blockId: string,
  blocks: readonly FlatBlock[],
  enclosing: ReadonlyMap<string, { sectionId: string | null; chapterId: string | null }>,
): DecisionRecord[] {
  return decisions.filter(
    (decision) =>
      decision.status === 'accepted' &&
      decisionApplies(decision.scope, blockId, blocks, enclosing),
  );
}

/**
 * Does a decision already settle this finding?
 *
 * Suppression is deliberately narrow. A decision silences a finding only when
 * it names the same passage and the same vocabulary - a general preference
 * should inform the model's judgement, not blanket-silence whole categories of
 * consequence it was never asked about.
 */
export function decisionSuppresses(
  decision: DecisionRecord,
  finding: { targetBlockId: string; impactType: string; terms: readonly string[] },
): boolean {
  if (decision.status !== 'accepted') return false;
  if (!decision.suppressBlockId) return false;
  if (decision.suppressBlockId !== finding.targetBlockId) return false;

  if (decision.suppressImpactType && decision.suppressImpactType !== finding.impactType) {
    return false;
  }

  // With no terms recorded, the block and type match is enough.
  if (decision.suppressTerms.length === 0) return true;

  const lowered = finding.terms.map((term) => term.toLowerCase());
  return decision.suppressTerms.some((term) => lowered.includes(term.toLowerCase()));
}

// --------------------------------------------------------------------------
// Conflict detection
// --------------------------------------------------------------------------

/**
 * "Use X rather than Y", "prefer X over Y", "say X instead of Y".
 *
 * A directional preference is the form a terminology decision almost always
 * takes, and it is the form that can contradict another one outright.
 */
const PREFERENCE =
  /\b(?:use|prefer|say|write|adopt)\s+["'“]?([\p{L}\p{N} '’-]{2,40}?)["'”]?\s+(?:rather than|instead of|over|and not|not)\s+["'“]?([\p{L}\p{N} '’-]{2,40}?)["'”]?(?=[.,;:]|\s+(?:when|where|unless|in|for|throughout)\b|$)/giu;

export interface Preference {
  preferred: string;
  rejected: string;
}

export function extractPreferences(text: string): Preference[] {
  const out: Preference[] = [];

  for (const match of text.matchAll(PREFERENCE)) {
    const preferred = match[1].trim().toLowerCase();
    const rejected = match[2].trim().toLowerCase();
    if (!preferred || !rejected || preferred === rejected) continue;
    out.push({ preferred, rejected });
  }

  return out;
}

export type ConflictKind = 'inverted' | 'competing';

export interface DecisionConflict {
  a: string;
  b: string;
  kind: ConflictKind;
  explanation: string;
}

/** Do two scopes cover any of the same ground? */
export function scopesOverlap(a: DecisionScope, b: DecisionScope): boolean {
  if (a.type === 'document' || b.type === 'document') return true;
  // Without resolving positions here, two anchored scopes are treated as
  // overlapping when they share an anchor; anything finer would need the
  // document, and a false "no overlap" would hide a real conflict.
  return a.nodeId === b.nodeId;
}

/**
 * Contradictions between decisions in force.
 *
 * Two kinds are detected locally:
 *
 *   inverted  - one prefers X over Y, the other prefers Y over X
 *   competing - both replace the same term, with different replacements
 *
 * Semantic contradiction that is not phrased as a preference is out of reach
 * of a rule, and is not guessed at.
 */
export function detectDecisionConflicts(
  decisions: readonly DecisionRecord[],
): DecisionConflict[] {
  const active = decisions.filter((decision) => decision.status === 'accepted');
  const parsed = active.map((decision) => ({
    decision,
    preferences: extractPreferences(`${decision.title}. ${decision.description}`),
  }));

  const conflicts: DecisionConflict[] = [];

  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const left = parsed[i];
      const right = parsed[j];
      if (!scopesOverlap(left.decision.scope, right.decision.scope)) continue;

      for (const a of left.preferences) {
        for (const b of right.preferences) {
          if (a.preferred === b.rejected && a.rejected === b.preferred) {
            conflicts.push({
              a: left.decision.id,
              b: right.decision.id,
              kind: 'inverted',
              explanation: `One prefers "${a.preferred}" over "${a.rejected}"; the other prefers the reverse.`,
            });
            continue;
          }

          if (a.rejected === b.rejected && a.preferred !== b.preferred) {
            conflicts.push({
              a: left.decision.id,
              b: right.decision.id,
              kind: 'competing',
              explanation: `Both replace "${a.rejected}", one with "${a.preferred}" and the other with "${b.preferred}".`,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/** Free-text search over decisions, for the sidebar. */
export function searchDecisions(
  decisions: readonly DecisionRecord[],
  query: string,
): DecisionRecord[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...decisions];

  return decisions.filter((decision) => {
    const haystack = `${decision.title} ${decision.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
