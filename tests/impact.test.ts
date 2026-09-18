import { describe, expect, it } from 'vitest';

import {
  parseImpactReply,
  buildImpactMessage,
  UnreadableImpactReplyError,
} from '@/ai/impact-prompt';
import { clusterChanges } from '@/core/cluster';
import { contentHash } from '@/core/hash';
import type { ChangeClassification, ChangeRecord, ImpactCandidate } from '@/core/types';

const reply = (impacts: unknown[], summary = 'A summary.') =>
  JSON.stringify({ summary, impacts });

let counter = 0;

const ledgerEntry = (
  blockId: string,
  before: string,
  after: string,
  classification: ChangeClassification = 'terminology',
): ChangeRecord => ({
  id: `chg_${++counter}`,
  documentId: 'doc_1',
  blockId,
  blockType: 'paragraph',
  authorId: 'usr_test',
  source: 'human',
  operation: 'replace',
  classification,
  before,
  after,
  beforeHash: contentHash(before),
  afterHash: contentHash(after),
  sessionId: 'sess_1',
  revision: 2,
  checkpointId: null,
  impactStatus: 'pending',
  prompt: null,
  model: null,
  suggestionId: null,
  occurredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

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
  const change = ledgerEntry(
    'p_1',
    'the probability of an incident',
    'the likelihood of an incident',
  );

  const currentText = new Map([['p_1', 'the likelihood of an incident']]);

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
      currentText,
      candidates,
    });

    expect(message).toContain('### Candidate 1 - p_77');
    expect(message).toContain('The probability of failure remains under review.');
  });

  it('describes what changed, not just that something did', () => {
    const message = buildImpactMessage({
      documentTitle: 'Governance',
      clusters: clusterChanges([change]),
      currentText,
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
      currentText,
      candidates,
    });

    expect(message).toContain('## Document brief');
    expect(message).toContain('Sets out duties for high-risk systems.');
  });
});

/*
 * What a changed passage now says.
 *
 * On a real manuscript a paragraph that had been swept and then rewritten was
 * described twice, in two clusters, each saying "Now reads" and each quoting a
 * different sentence. The second was history: the passage had not read that way
 * for an edit. A model told a passage says something it does not can only
 * produce a finding about text that is not there.
 */
describe('buildImpactMessage on a passage edited twice since the checkpoint', () => {
  const ORIGINAL =
    'Sunset is the moment at which the geometric sun is already wholly beneath the true horizon.';
  const SWAPPED =
    'Sunset is the moment at which the geometric sun is already wholly beneath the astronomical horizon.';
  const CURRENT =
    'Sunset is the moment at which the geometric sun has already passed wholly beneath the ' +
    'astronomical horizon, refraction notwithstanding.';

  const clusters = clusterChanges([
    // A focused term swap, then a broader rewrite of the same paragraph.
    ledgerEntry('p_wgjogypt60', ORIGINAL, SWAPPED, 'terminology'),
    ledgerEntry('p_wgjogypt60', SWAPPED, CURRENT, 'editorial'),
  ]);

  const candidates: ImpactCandidate[] = [
    {
      blockId: 'p_77',
      text: 'Civil twilight ends when the sun reaches six degrees below the horizon.',
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

  const message = buildImpactMessage({
    documentTitle: 'Twilight',
    clusters,
    currentText: new Map([
      ['p_wgjogypt60', CURRENT],
      ['p_77', candidates[0].text],
    ]),
    candidates,
  });

  const changesMade = message.split('## Candidate passages')[0];

  it('describes the passage exactly once', () => {
    expect(changesMade.match(/p_wgjogypt60/g) ?? []).toHaveLength(1);
  });

  it('quotes the passage as the document now has it', () => {
    expect(changesMade).toContain(CURRENT);
  });

  it('never shows superseded text as what the passage currently says', () => {
    expect(changesMade).not.toContain('the true horizon');
    expect(changesMade).not.toContain(SWAPPED);
  });

  it('reports a deleted passage as gone rather than quoting the ledger', () => {
    const withoutTheBlock = buildImpactMessage({
      documentTitle: 'Twilight',
      clusters,
      currentText: new Map([['p_77', candidates[0].text]]),
      candidates,
    });

    const section = withoutTheBlock.split('## Candidate passages')[0];
    expect(section).toContain('p_wgjogypt60 has since been deleted');
    expect(section).not.toContain('astronomical horizon');
  });
});
