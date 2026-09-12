import { describe, expect, it } from 'vitest';

import {
  parseImpactReply,
  buildImpactMessage,
  UnreadableImpactReplyError,
} from '@/ai/impact-prompt';
import { clusterChanges } from '@/core/cluster';
import { contentHash } from '@/core/hash';
import type { ChangeRecord, ImpactCandidate } from '@/core/types';

const reply = (impacts: unknown[], summary = 'A summary.') =>
  JSON.stringify({ summary, impacts });

describe('parseImpactReply', () => {
  it('reads a well-formed reply', () => {
    const parsed = parseImpactReply(
      reply([
        {
          candidate: 2,
          impact_type: 'terminology_consistency',
          severity: 'high',
          confidence: 0.9,
          explanation: 'Still uses the old term.',
          recommended_action: 'revise',
        },
      ]),
      3,
    );

    expect(parsed.summary).toBe('A summary.');
    expect(parsed.impacts).toEqual([
      {
        candidate: 2,
        impactType: 'terminology_consistency',
        severity: 'high',
        confidence: 0.9,
        explanation: 'Still uses the old term.',
        recommendedAction: 'revise',
      },
    ]);
  });

  it('reads a reply wrapped in a markdown fence', () => {
    const parsed = parseImpactReply(
      '```json\n' + reply([]) + '\n```',
      1,
    );
    expect(parsed.summary).toBe('A summary.');
  });

  it('drops a finding about a passage that was never shown', () => {
    // A citation of candidate 9 when 3 were sent is a hallucination, not a hint.
    const parsed = parseImpactReply(
      reply([
        { candidate: 9, explanation: 'Invented.', severity: 'high' },
        { candidate: 1, explanation: 'Real.', severity: 'low' },
      ]),
      3,
    );

    expect(parsed.impacts.map((impact) => impact.candidate)).toEqual([1]);
  });

  it('drops a finding with no explanation', () => {
    const parsed = parseImpactReply(reply([{ candidate: 1, severity: 'high' }]), 3);
    expect(parsed.impacts).toEqual([]);
  });

  it('falls back on unknown enum values rather than discarding the finding', () => {
    const parsed = parseImpactReply(
      reply([
        {
          candidate: 1,
          impact_type: 'something_invented',
          severity: 'catastrophic',
          recommended_action: 'panic',
          explanation: 'Still relevant.',
        },
      ]),
      1,
    );

    expect(parsed.impacts[0]).toMatchObject({
      impactType: 'other',
      severity: 'low',
      recommendedAction: 'review',
    });
  });

  it('clamps confidence into range', () => {
    const parsed = parseImpactReply(
      reply([{ candidate: 1, confidence: 4.5, explanation: 'x' }]),
      1,
    );
    expect(parsed.impacts[0].confidence).toBe(1);
  });

  it('accepts an empty finding list - that is a real answer', () => {
    const parsed = parseImpactReply(reply([], 'Nothing downstream depends on this.'), 5);
    expect(parsed.impacts).toEqual([]);
    expect(parsed.summary).toBe('Nothing downstream depends on this.');
  });

  it('refuses a reply with no JSON in it', () => {
    expect(() => parseImpactReply('I could not complete this task.', 3)).toThrow(
      UnreadableImpactReplyError,
    );
  });
});

describe('buildImpactMessage', () => {
  const change: ChangeRecord = {
    id: 'chg_1',
    documentId: 'doc_1',
    blockId: 'p_1',
    blockType: 'paragraph',
    authorId: 'usr_test',
    source: 'human',
    operation: 'replace',
    classification: 'terminology',
    before: 'the probability of an incident',
    after: 'the likelihood of an incident',
    beforeHash: contentHash('a'),
    afterHash: contentHash('b'),
    sessionId: 'sess_1',
    revision: 2,
    checkpointId: null,
    impactStatus: 'pending',
    prompt: null,
    model: null,
    suggestionId: null,
    occurredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  const candidates: ImpactCandidate[] = [
    {
      blockId: 'p_77',
      text: 'The probability of failure remains under review.',
      score: 3,
      signals: {
        exactTerm: true,
        definition: false,
        crossReference: false,
        citation: false,
        numeric: false,
        lexicalRank: 1,
        semanticRank: null,
      },
    },
  ];

  it('numbers the candidates so findings can be tied back to them', () => {
    const message = buildImpactMessage({
      documentTitle: 'Governance',
      clusters: clusterChanges([change]),
      candidates,
    });

    expect(message).toContain('### Candidate 1 - p_77');
    expect(message).toContain('The probability of failure remains under review.');
  });

  it('describes what changed, not just that something did', () => {
    const message = buildImpactMessage({
      documentTitle: 'Governance',
      clusters: clusterChanges([change]),
      candidates,
    });

    expect(message).toContain('probability');
    expect(message).toContain('likelihood');
    expect(message).toContain('[terminology]');
  });

  it('includes the document brief when the index has one', () => {
    const message = buildImpactMessage({
      documentTitle: 'Governance',
      documentBrief: 'Sets out duties for high-risk systems.',
      clusters: clusterChanges([change]),
      candidates,
    });

    expect(message).toContain('## Document brief');
    expect(message).toContain('Sets out duties for high-risk systems.');
  });
});
