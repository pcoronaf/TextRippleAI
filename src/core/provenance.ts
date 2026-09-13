/**
 * Walking a change back to its origin.
 *
 * Pure: given the records, it follows the stored links. Fetching them is the
 * server layer's job, which keeps the part that can be wrong - the walk -
 * testable against real records without a running store.
 *
 *   change.suggestionId -> suggestion.sourceImpactId -> impact.sourceChangeIds
 *
 * Every hop is a stored link rather than something re-derived from the text, so
 * the answer survives every later edit to any paragraph involved.
 */

import type {
  ChangeProvenance,
  ChangeRecord,
  ImpactAnalysisRecord,
  ImpactRecord,
  SuggestionRecord,
} from './types';

export interface ProvenanceInput {
  changeId: string;
  changes: readonly ChangeRecord[];
  suggestions: readonly SuggestionRecord[];
  impacts: readonly ImpactRecord[];
  analyses: readonly ImpactAnalysisRecord[];
}

export function traceProvenance(input: ProvenanceInput): ChangeProvenance | null {
  const change = input.changes.find((entry) => entry.id === input.changeId);
  if (!change) return null;

  const suggestion = change.suggestionId
    ? (input.suggestions.find((entry) => entry.id === change.suggestionId) ?? null)
    : null;

  const impact = suggestion?.sourceImpactId
    ? (input.impacts.find((entry) => entry.id === suggestion.sourceImpactId) ?? null)
    : null;

  const analysis = impact
    ? (input.analyses.find((entry) => entry.id === impact.impactAnalysisId) ?? null)
    : null;

  // Order follows the ledger, so a multi-change origin reads chronologically.
  const originChanges = impact
    ? input.changes.filter((entry) => impact.sourceChangeIds.includes(entry.id))
    : [];

  return { change, suggestion, impact, analysis, originChanges };
}
