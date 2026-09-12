import { describe, expect, it } from 'vitest';

import {
  detectCitations,
  detectClaims,
  detectDefinitions,
  extractSemanticUnits,
  extractTerms,
  splitSentences,
} from '@/core/semantics';
import { enclosingHeadings, ensureNodeIds, flattenBlocks, regions } from '@/core/document';
import { planInvalidation } from '@/core/index-plan';
import { cosineSimilarity, normalise } from '@/core/vector';
import type { DocumentContent } from '@/core/types';

const values = (units: { value: string }[]) => units.map((unit) => unit.value);

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('One claim. Another claim! A third?')).toEqual([
      'One claim.',
      'Another claim!',
      'A third?',
    ]);
  });

  it('does not split on common abbreviations', () => {
    expect(splitSentences('Systems (e.g. classifiers) are covered. The rest are not.')).toEqual([
      'Systems (e.g. classifiers) are covered.',
      'The rest are not.',
    ]);
  });
});

describe('detectDefinitions', () => {
  it('finds the standard defining forms', () => {
    expect(values(detectDefinitions('A high-risk system means a system listed in Annex III.'))).toEqual(
      ['high-risk system'],
    );
    expect(values(detectDefinitions('Oversight is defined as review by a competent person.'))).toEqual(
      ['Oversight'],
    );
    expect(values(detectDefinitions('For the purposes of this policy, "trust" refers to earned confidence.'))).toEqual(
      ['trust'],
    );
  });

  it('does not treat ordinary prose as a definition', () => {
    expect(detectDefinitions('The system is fast and the results are encouraging.')).toEqual([]);
  });
});

describe('detectClaims', () => {
  it('separates requirements from assertions', () => {
    const claims = detectClaims(
      'The operator shall log every access. Accuracy improved by 12 percent. Consider the alternatives.',
    );

    expect(claims).toHaveLength(2);
    expect(claims[0].rule).toBe('requirement');
    expect(claims[1].rule).toBe('assertion');
  });

  it('skips questions and fragments', () => {
    expect(detectClaims('Is this so? Yes.')).toEqual([]);
  });
});

describe('extractTerms', () => {
  it('finds acronyms and standards', () => {
    const terms = values(extractTerms('The ISO/IEC 42001 standard governs AI management systems.'));
    expect(terms).toContain('ISO/IEC');
    expect(terms).toContain('AI');
  });

  it('finds quoted terms', () => {
    expect(values(extractTerms('We prefer "human oversight" throughout.'))).toContain(
      'human oversight',
    );
  });

  it('does not mistake a sentence-initial capital for a proper noun', () => {
    // "Systems" only leads the sentence; it is not a name.
    expect(values(extractTerms('Systems are audited annually.'))).not.toContain('Systems are');
  });
});

describe('detectCitations', () => {
  it('finds bracketed, authored and standard references', () => {
    const found = values(
      detectCitations('As shown [12] and by (Smith, 2019), see also ISO/IEC 27001.'),
    );
    expect(found).toContain('[12]');
    expect(found).toContain('(Smith, 2019)');
    expect(found).toContain('ISO/IEC 27001');
  });
});

describe('extractSemanticUnits', () => {
  it('returns nothing for empty text', () => {
    expect(extractSemanticUnits('   ')).toEqual([]);
  });

  it('collects every kind from one passage', () => {
    const units = extractSemanticUnits(
      'A high-risk system means a system listed in Annex III [7]. The operator shall review it.',
    );
    const kinds = new Set(units.map((unit) => unit.type));

    expect(kinds.has('definition')).toBe(true);
    expect(kinds.has('claim')).toBe(true);
    expect(kinds.has('citation')).toBe(true);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('refuses to compare vectors of different lengths', () => {
    // Different lengths mean two embedding models; a number here would be a
    // meaningless ranking rather than an error.
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('normalises to unit length', () => {
    const unit = normalise([3, 4]);
    expect(Math.hypot(...unit)).toBeCloseTo(1);
  });
});

const manuscript = (): DocumentContent =>
  ensureNodeIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Directly under the chapter.' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section A' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Inside section A.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Also inside section A.' }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter Two' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Inside chapter two.' }] },
    ],
  }).content;

describe('document regions', () => {
  const content = manuscript();
  const blocks = flattenBlocks(content);
  const byText = (text: string) => blocks.find((block) => block.text === text)!;

  it('gives a chapter every block beneath it, including its subsections', () => {
    const chapterOne = regions(content).find((region) => region.title === 'Chapter One')!;
    const texts = chapterOne.blockIds.map((id) => blocks.find((block) => block.id === id)!.text);

    expect(texts).toEqual([
      'Directly under the chapter.',
      'Inside section A.',
      'Also inside section A.',
    ]);
  });

  it('gives a section only its own blocks', () => {
    const sectionA = regions(content).find((region) => region.title === 'Section A')!;
    expect(sectionA.blockIds).toHaveLength(2);
  });

  it('stops a chapter at the next chapter', () => {
    const chapterTwo = regions(content).find((region) => region.title === 'Chapter Two')!;
    expect(chapterTwo.blockIds).toHaveLength(1);
  });

  it('maps each block to its enclosing section and chapter', () => {
    const enclosing = enclosingHeadings(content);
    const inSection = enclosing.get(byText('Inside section A.').id)!;

    expect(inSection.sectionId).toBe(byText('Section A').id);
    expect(inSection.chapterId).toBe(byText('Chapter One').id);
  });
});

describe('planInvalidation', () => {
  const content = manuscript();
  const blocks = flattenBlocks(content);
  const byText = (text: string) => blocks.find((block) => block.text === text)!;

  it('makes the section stale and the chapter merely suspect', () => {
    const plan = planInvalidation(content, [byText('Inside section A.').id]);

    expect(plan.staleBlockIds).toEqual([byText('Inside section A.').id]);
    expect(plan.staleSummaryNodeIds).toEqual([byText('Section A').id]);
    expect(plan.potentiallyStaleSummaryNodeIds).toEqual([byText('Chapter One').id]);
    expect(plan.documentSummaryAffected).toBe(true);
  });

  it('makes a chapter definitely stale when its own prose changes', () => {
    // No subsection stands between the block and the chapter heading, so the
    // chapter summary is not merely suspect - it is wrong.
    const plan = planInvalidation(content, [byText('Directly under the chapter.').id]);

    expect(plan.staleSummaryNodeIds).toContain(byText('Chapter One').id);
    expect(plan.potentiallyStaleSummaryNodeIds).not.toContain(byText('Chapter One').id);
  });

  it('leaves other chapters alone', () => {
    const plan = planInvalidation(content, [byText('Inside section A.').id]);
    expect(plan.potentiallyStaleSummaryNodeIds).not.toContain(byText('Chapter Two').id);
    expect(plan.staleSummaryNodeIds).not.toContain(byText('Chapter Two').id);
  });

  it('does nothing when nothing changed', () => {
    expect(planInvalidation(content, [])).toEqual({
      staleBlockIds: [],
      staleSummaryNodeIds: [],
      potentiallyStaleSummaryNodeIds: [],
      documentSummaryAffected: false,
    });
  });
});
