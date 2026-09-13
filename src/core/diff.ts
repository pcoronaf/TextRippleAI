/** Word-level before/after diffing for the change review interface. */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffSegment {
  op: DiffOp;
  value: string;
}

/**
 * Split into alternating word and whitespace tokens.
 *
 * Whitespace is tokenised separately so that "b" and "b " compare equal as
 * words; attaching trailing space to the word makes the last word of a
 * paragraph mismatch its own copy and inflates the diff.
 */
export function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/** Beyond this DP size, fall back to a whole-block replacement. */
const MAX_MATRIX_CELLS = 1_000_000;

/**
 * Word-level diff. Common prefixes and suffixes are trimmed before the LCS
 * table is built, which keeps the usual case (a few words edited in a
 * paragraph) close to linear.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) {
    return before ? [{ op: 'equal', value: before }] : [];
  }

  const a = tokenize(before);
  const b = tokenize(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }

  const prefix = a.slice(0, start).join('');
  const suffix = a.slice(a.length - end).join('');
  const aMid = a.slice(start, a.length - end);
  const bMid = b.slice(start, b.length - end);

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, value: string) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.value += value;
    else segments.push({ op, value });
  };

  push('equal', prefix);

  if ((aMid.length + 1) * (bMid.length + 1) > MAX_MATRIX_CELLS) {
    push('delete', aMid.join(''));
    push('insert', bMid.join(''));
  } else {
    for (const segment of lcsDiff(aMid, bMid)) push(segment.op, segment.value);
  }

  push('equal', suffix);
  return segments;
}

function lcsDiff(a: string[], b: string[]): DiffSegment[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, value: string) => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.value += value;
    else segments.push({ op, value });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      push('delete', a[i]);
      i++;
    } else {
      push('insert', b[j]);
      j++;
    }
  }
  while (i < a.length) push('delete', a[i++]);
  while (j < b.length) push('insert', b[j++]);

  return segments;
}

/** Token counts for each side of a diff, used by change classification. */
export function diffStats(segments: DiffSegment[]): {
  inserted: number;
  deleted: number;
  unchanged: number;
} {
  let inserted = 0;
  let deleted = 0;
  let unchanged = 0;
  for (const segment of segments) {
    const count = tokenize(segment.value).filter((token) => token.trim()).length;
    if (segment.op === 'insert') inserted += count;
    else if (segment.op === 'delete') deleted += count;
    else unchanged += count;
  }
  return { inserted, deleted, unchanged };
}

export interface TextRange {
  from: number;
  to: number;
}

/**
 * Character ranges in `after` that were not in `before`.
 *
 * Used to mark, inside a changed paragraph, the words that actually moved
 * rather than shading the whole thing. Deletions are not represented: the text
 * is gone from `after`, and showing it would mean inserting words the document
 * does not contain.
 *
 * Adjacent insertions are merged so a run of edited words is one mark rather
 * than a row of them separated by nothing.
 */
export function insertedRanges(before: string, after: string): TextRange[] {
  if (before === after) return [];
  if (!before) return after ? [{ from: 0, to: after.length }] : [];

  const ranges: TextRange[] = [];
  let offset = 0;

  for (const segment of diffWords(before, after)) {
    // A deleted segment occupies no space in `after`, so it moves no offset.
    if (segment.op === 'delete') continue;

    const length = segment.value.length;
    if (segment.op === 'insert' && length > 0) {
      const last = ranges[ranges.length - 1];
      if (last && last.to === offset) last.to = offset + length;
      else ranges.push({ from: offset, to: offset + length });
    }
    offset += length;
  }

  return ranges;
}
