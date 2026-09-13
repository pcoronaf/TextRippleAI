/**
 * Propagation: turning an impact finding into a proposed downstream edit.
 *
 * This is a narrower job than an ordinary rewrite. The author did not ask for
 * the passage to be improved; they asked for a specific inconsistency to stop
 * existing. Anything else the model changes is damage it was not asked to do,
 * and it will be reviewed under the impression that it was necessary.
 */

import type { ChangeCluster } from '@/core/cluster';
import type { ImpactRecord } from '@/core/types';

import { MODIFY_SYSTEM } from './prompts';

export const PROPAGATION_SYSTEM = `${MODIFY_SYSTEM}

This particular rewrite exists to resolve a specific inconsistency that an earlier change created elsewhere in the document. You will be told what changed, and why this passage is affected.

Additional rules for this case:
- Make the smallest edit that resolves the stated inconsistency. Not the best version of the paragraph - the closest version to the original that is no longer inconsistent.
- Do not import the new wording mechanically. If the passage uses a term in a different sense from the one that changed, the right edit may be no edit at all; say so in the rationale and return the passage unchanged.
- Leave everything the finding did not mention exactly as it is, including anything you would otherwise improve.
- The rationale should say what inconsistency you resolved and how, in one or two sentences.`;

/** The instruction recorded against the proposal, and shown to the author. */
export function propagationInstruction(impact: ImpactRecord): string {
  return `Resolve the ${impact.impactType.replace(/_/g, ' ')} identified by impact analysis: ${impact.explanation}`;
}

/** Context describing the originating change and the finding it produced. */
export function propagationContext(input: {
  impact: ImpactRecord;
  clusters: ChangeCluster[];
  originChangeSummaries: { before: string; after: string }[];
}): string {
  const lines: string[] = [];

  if (input.clusters.length > 0) {
    lines.push(
      `What changed earlier: ${input.clusters.map((cluster) => cluster.label).join('; ')}`,
    );
  }

  for (const change of input.originChangeSummaries.slice(0, 3)) {
    lines.push(`- was: "${change.before.slice(0, 240)}"`);
    lines.push(`  now: "${change.after.slice(0, 240)}"`);
  }

  lines.push('');
  lines.push(`Why this passage is affected (${input.impact.severity} severity): ${input.impact.explanation}`);
  lines.push(`Recommended action: ${input.impact.recommendedAction.replace(/_/g, ' ')}`);

  return lines.join('\n');
}
