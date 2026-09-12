import { describe, expect, it } from 'vitest';

import { classifyChange, isTrivial } from '@/core/classify';
import { diffStats, diffWords } from '@/core/diff';

const render = (before: string, after: string) =>
  diffWords(before, after)
    .map((segment) =>
      segment.op === 'insert' ? `+${segment.value}` : segment.op === 'delete' ? `-${segment.value}` : segment.value,
    )
    .join('');

describe('diffWords', () => {
  it('returns a single equal segment for identical text', () => {
    expect(diffWords('same text', 'same text')).toEqual([{ op: 'equal', value: 'same text' }]);
  });

  it('isolates the words that changed', () => {
    const segments = diffWords(
      'the likelihood of a cybersecurity incident',
      'the probability of a cybersecurity incident',
    );

    expect(segments.filter((segment) => segment.op === 'delete').map((s) => s.value.trim())).toEqual(
      ['likelihood'],
    );
    expect(segments.filter((segment) => segment.op === 'insert').map((s) => s.value.trim())).toEqual(
      ['probability'],
    );
  });

  it('reconstructs both sides losslessly', () => {
    const before = 'Zero Trust assumes that no user should automatically be trusted.';
    const after = 'Zero Trust avoids granting implicit trust to any user or device.';
    const segments = diffWords(before, after);

    const left = segments
      .filter((segment) => segment.op !== 'insert')
      .map((segment) => segment.value)
      .join('');
    const right = segments
      .filter((segment) => segment.op !== 'delete')
      .map((segment) => segment.value)
      .join('');

    expect(left).toBe(before);
    expect(right).toBe(after);
  });

  it('handles insertion at the start and deletion at the end', () => {
    expect(render('b c', 'a b c')).toBe('+a b c');
    expect(render('a b c', 'a b')).toBe('a b- c');
  });

  it('counts tokens per side', () => {
    expect(diffStats(diffWords('one two three', 'one four three'))).toEqual({
      inserted: 1,
      deleted: 1,
      unchanged: 2,
    });
  });

  it('degrades to a whole-block replacement for very large inputs', () => {
    const before = Array.from({ length: 1200 }, (_, i) => `a${i}`).join(' ');
    const after = Array.from({ length: 1200 }, (_, i) => `b${i}`).join(' ');
    const segments = diffWords(before, after);

    expect(segments.map((segment) => segment.op)).toEqual(['delete', 'insert']);
  });
});

describe('classifyChange', () => {
  const classify = (before: string, after: string, blockType = 'paragraph') =>
    classifyChange({ blockType, operation: 'replace', before, after });

  it('treats spacing and smart punctuation as typographical', () => {
    expect(classify('one  two', 'one two')).toBe('typographical');
    expect(classify('the “quote”', 'the "quote"')).toBe('typographical');
    expect(classify('a - b', 'a — b')).toBe('typographical');
    expect(isTrivial('typographical')).toBe(true);
  });

  it('detects a numeric change behind unchanged wording', () => {
    expect(classify('accuracy reached 35% overall', 'accuracy reached 41% overall')).toBe(
      'numerical_value',
    );
  });

  it('detects citation changes', () => {
    expect(classify('as shown [12]', 'as shown [13]')).toBe('citation');
  });

  it('detects cross-reference changes', () => {
    expect(classify('as discussed in Chapter 3', 'as discussed in Chapter 4')).toBe(
      'cross_reference',
    );
  });

  it('detects definitions', () => {
    expect(
      classify(
        'A high-risk system means a system listed in Annex III.',
        'A high-risk system means a system designated by the authority.',
      ),
    ).toBe('definition');
  });

  it('detects a change in requirement strength', () => {
    expect(classify('The operator must log access.', 'The operator should log access.')).toBe(
      'requirement',
    );
  });

  it('reads a small word swap as terminology', () => {
    expect(
      classify('the probability of an incident rises', 'the likelihood of an incident rises'),
    ).toBe('terminology');
  });

  it('treats structural operations as structural', () => {
    expect(classifyChange({ blockType: 'heading', operation: 'replace', before: 'A', after: 'B' })).toBe(
      'structural',
    );
    expect(
      classifyChange({ blockType: 'paragraph', operation: 'insert', before: '', after: 'New' }),
    ).toBe('structural');
  });

  it('falls back to editorial for a substantial rewrite', () => {
    expect(
      classify(
        'This section explains the method.',
        'The following pages set out, step by step, how the study was carried out and why each decision was taken.',
      ),
    ).toBe('editorial');
  });
});
