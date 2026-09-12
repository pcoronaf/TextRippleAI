import { describe, expect, it } from 'vitest';

import { ChangeAggregator } from '@/core/change-aggregator';
import type { FlatBlock } from '@/core/types';

const block = (id: string, text: string, type = 'paragraph'): FlatBlock => ({
  id,
  type,
  text,
  position: 0,
  parentId: null,
  attrs: {},
});

const IDLE = 1500;

function aggregator(initial: FlatBlock[]) {
  return new ChangeAggregator(initial, { sessionId: 'sess_test', idleMs: IDLE });
}

describe('ChangeAggregator', () => {
  it('collapses a burst of typing into one meaningful change', () => {
    // Acceptance criterion: typing a word creates one change, not one per keystroke.
    const target = 'cybersecurity';
    const agg = aggregator([block('p_1', 'cyber security')]);

    let clock = 0;
    for (let i = 1; i <= target.length; i++) {
      clock += 90;
      agg.observe([block('p_1', target.slice(0, i))], clock);
    }

    // Still inside the quiet period: nothing has matured.
    expect(agg.drain(clock)).toEqual([]);
    expect(agg.pendingCount).toBe(1);

    const changes = agg.drain(clock + IDLE);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      blockId: 'p_1',
      operation: 'replace',
      before: 'cyber security',
      after: 'cybersecurity',
      sessionId: 'sess_test',
    });
    expect(changes[0].beforeHash).toMatch(/^sha256:/);
    expect(agg.pendingCount).toBe(0);
  });

  it('captures a manual paragraph rewrite with before and after values', () => {
    const before = 'Artificial intelligence systems always require human supervision.';
    const after =
      'High-risk artificial intelligence systems should normally remain subject to meaningful human oversight.';

    const agg = aggregator([block('p_78f24', before)]);
    agg.observe([block('p_78f24', after)], 100);

    const [change] = agg.drain(100 + IDLE);
    expect(change.before).toBe(before);
    expect(change.after).toBe(after);
    expect(change.classification).toBe('requirement');
  });

  it('keeps each edited block as its own change', () => {
    const agg = aggregator([block('p_1', 'One'), block('p_2', 'Two')]);

    agg.observe([block('p_1', 'One edited'), block('p_2', 'Two')], 100);
    agg.observe([block('p_1', 'One edited'), block('p_2', 'Two edited')], 200);

    const changes = agg.drain(200 + IDLE).sort((a, b) => a.blockId.localeCompare(b.blockId));
    expect(changes.map((change) => change.blockId)).toEqual(['p_1', 'p_2']);
  });

  it('does not extend one block quiet period because another block is edited', () => {
    const agg = aggregator([block('p_1', 'One'), block('p_2', 'Two')]);

    agg.observe([block('p_1', 'One edited'), block('p_2', 'Two')], 0);
    // Keep typing in p_2 well past p_1's quiet period.
    for (let clock = 200; clock <= 3000; clock += 200) {
      agg.observe([block('p_1', 'One edited'), block('p_2', `Two${clock}`)], clock);
    }

    const changes = agg.drain(3000);
    expect(changes.map((change) => change.blockId)).toEqual(['p_1']);
  });

  it('records nothing when an edit is undone', () => {
    const agg = aggregator([block('p_1', 'Original')]);

    agg.observe([block('p_1', 'Originalx')], 100);
    agg.observe([block('p_1', 'Original')], 200);

    expect(agg.pendingCount).toBe(0);
    expect(agg.drain(200 + IDLE)).toEqual([]);
  });

  it('records an inserted block', () => {
    const agg = aggregator([block('p_1', 'One')]);
    agg.observe([block('p_1', 'One'), block('p_2', 'Brand new paragraph')], 100);

    const [change] = agg.drain(100 + IDLE);
    expect(change).toMatchObject({
      blockId: 'p_2',
      operation: 'insert',
      before: '',
      after: 'Brand new paragraph',
    });
  });

  it('records a deleted block', () => {
    const agg = aggregator([block('p_1', 'One'), block('p_2', 'Two')]);
    agg.observe([block('p_1', 'One')], 100);

    const [change] = agg.drain(100 + IDLE);
    expect(change).toMatchObject({ blockId: 'p_2', operation: 'delete', before: 'Two', after: '' });
  });

  it('leaves nothing behind when a block is added and removed again', () => {
    const agg = aggregator([block('p_1', 'One')]);
    agg.observe([block('p_1', 'One'), block('p_2', 'Temporary')], 100);
    agg.observe([block('p_1', 'One')], 200);

    expect(agg.drainAll(300)).toEqual([]);
  });

  it('flushes everything on demand, ignoring the quiet period', () => {
    const agg = aggregator([block('p_1', 'One')]);
    agg.observe([block('p_1', 'One edited')], 100);

    expect(agg.drain(150)).toEqual([]);
    expect(agg.drainAll(150)).toHaveLength(1);
  });

  it('flushes a long continuous edit once the hard cap is reached', () => {
    const agg = new ChangeAggregator([block('p_1', 'Start')], {
      sessionId: 'sess_test',
      idleMs: IDLE,
      maxPendingMs: 2000,
    });

    for (let clock = 100; clock <= 2100; clock += 100) {
      agg.observe([block('p_1', `Start${clock}`)], clock);
    }

    expect(agg.drain(2100)).toHaveLength(1);
  });

  it('measures the next change against the state already in the ledger', () => {
    const agg = aggregator([block('p_1', 'One')]);

    agg.observe([block('p_1', 'Two')], 100);
    expect(agg.drain(100 + IDLE)[0]).toMatchObject({ before: 'One', after: 'Two' });

    agg.observe([block('p_1', 'Three')], 5000);
    expect(agg.drain(5000 + IDLE)[0]).toMatchObject({ before: 'Two', after: 'Three' });
  });

  it('classifies a whitespace-only edit as typographical', () => {
    const agg = aggregator([block('p_1', 'Zero  Trust assumes nothing.')]);
    agg.observe([block('p_1', 'Zero Trust assumes nothing.')], 100);

    expect(agg.drain(100 + IDLE)[0].classification).toBe('typographical');
  });
});
