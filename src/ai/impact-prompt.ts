/**
 * Impact reasoning: prompt and reply contract.
 *
 * The model is shown the conceptual changes and a shortlist of passages that
 * retrieval thinks might depend on them. Its job is to say which of those
 * passages are actually affected, and why - not to rewrite anything. Nothing
 * here can reach the document.
 */

import type {
  ChangeCluster,
} from '@/core/cluster';
import type {
  ImpactCandidate,
  ImpactSeverity,
  ImpactType,
  RecommendedAction,
} from '@/core/types';

export const IMPACT_SYSTEM = `You are analysing how a set of changes to a long-form document affects the rest of it.

You are given the conceptual changes that were made, and a shortlist of passages elsewhere in the document that retrieval suggests might depend on them. The shortlist is generated mechanically and is deliberately over-inclusive: most of it will be irrelevant.

Your job is to decide which passages are genuinely affected, and to say why.

What counts as an impact:
- The passage still uses terminology the change moved away from, in the same sense.
- The passage relies on a definition, threshold, figure or claim the change altered.
- The passage now contradicts the changed text, or asserts something the change withdrew.
- The passage points at the changed material by cross-reference and that pointer no longer holds.
- A conclusion or summary depends on a premise the change weakened or strengthened.

What does not count:
- Merely being about the same topic.
- Using the same word in a different sense. A change from "probability" to "likelihood" in prose does not affect a passage using "probability" in its strict mathematical sense - say so explicitly rather than flagging it.
- Being adjacent in the document.

Be strict. A briefing full of false positives gets ignored, which is worse than a shorter one. It is correct and useful to return no impacts at all.

Reply with JSON only - no prose before or after, no markdown fence:

{
  "summary": "Two or three sentences describing what changed conceptually and the shape of its consequences. Written for the author.",
  "impacts": [
    {
      "candidate": 3,
      "impact_type": "terminology_consistency | definition_conflict | contradiction | cross_reference | numeric_dependency | citation | scope | conclusion_dependency | other",
      "severity": "high | medium | low",
      "confidence": 0.0,
      "explanation": "Why this passage is affected, referring to what it actually says. One or two sentences.",
      "recommended_action": "revise | review | no_change"
    }
  ]
}

"candidate" is the number of the candidate passage. Include an entry only for passages that are genuinely affected. Set "recommended_action" to "no_change" when a passage is related but correctly left alone - that is a useful finding, not a filler one.`;

const IMPACT_TYPES: ImpactType[] = [
  'terminology_consistency',
  'definition_conflict',
  'contradiction',
  'cross_reference',
  'numeric_dependency',
  'citation',
  'scope',
  'conclusion_dependency',
  'other',
];

const SEVERITIES: ImpactSeverity[] = ['high', 'medium', 'low'];
const ACTIONS: RecommendedAction[] = ['revise', 'review', 'no_change'];

export interface ParsedImpact {
  candidate: number;
  impactType: ImpactType;
  severity: ImpactSeverity;
  confidence: number;
  explanation: string;
  recommendedAction: RecommendedAction;
}

export interface ParsedImpactReply {
  summary: string;
  impacts: ParsedImpact[];
}

export class UnreadableImpactReplyError extends Error {
  constructor(readonly raw: string) {
    super('The model did not return a readable impact analysis');
    this.name = 'UnreadableImpactReplyError';
  }
}

/** Pull the JSON object out of a reply that may be fenced or padded with prose. */
function extractJson(raw: string): unknown {
  const withoutFence = raw.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '');
  const candidates = [raw, withoutFence];

  for (const text of candidates) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Try the next shape.
    }
  }

  throw new UnreadableImpactReplyError(raw);
}

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;

/**
 * Parse the reply defensively.
 *
 * A malformed entry is dropped rather than guessed at: a fabricated finding
 * costs the author more than a missing one, because it has to be read and
 * dismissed before it can be ignored.
 */
export function parseImpactReply(raw: string, candidateCount: number): ParsedImpactReply {
  const parsed = extractJson(raw) as Record<string, unknown>;

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const entries = Array.isArray(parsed.impacts) ? parsed.impacts : [];

  const impacts: ParsedImpact[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;

    const candidate = Number(item.candidate);
    // A finding about a passage that was never shown is a hallucination.
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > candidateCount) continue;

    const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : '';
    if (!explanation) continue;

    const confidence = Number(item.confidence);

    impacts.push({
      candidate,
      impactType: oneOf(item.impact_type, IMPACT_TYPES, 'other'),
      severity: oneOf(item.severity, SEVERITIES, 'low'),
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
      explanation,
      recommendedAction: oneOf(item.recommended_action, ACTIONS, 'review'),
    });
  }

  return { summary, impacts };
}

/** Render the changes and the shortlist for the model. */
export function buildImpactMessage(input: {
  documentTitle: string;
  documentBrief?: string;
  clusters: ChangeCluster[];
  candidates: ImpactCandidate[];
  instructions?: string;
}): string {
  const parts: string[] = [`## Document\n${input.documentTitle}`];

  if (input.documentBrief?.trim()) {
    parts.push(`## Document brief\n${input.documentBrief.trim()}`);
  }

  parts.push(
    `## Changes made\n${input.clusters
      .map(
        (cluster, index) =>
          `${index + 1}. ${cluster.label} [${cluster.classification}] - ${cluster.size} ledger ${
            cluster.size === 1 ? 'entry' : 'entries'
          }\n   Now reads: ${cluster.afterText[0]?.slice(0, 400) ?? '(text removed)'}`,
      )
      .join('\n')}`,
  );

  parts.push(
    `## Candidate passages\n${input.candidates
      .map(
        (candidate, index) =>
          `### Candidate ${index + 1} - ${candidate.blockId}\n${candidate.text.slice(0, 900)}`,
      )
      .join('\n\n')}`,
  );

  if (input.instructions?.trim()) {
    parts.push(`## Additional instructions\n${input.instructions.trim()}`);
  }

  return parts.join('\n\n');
}
