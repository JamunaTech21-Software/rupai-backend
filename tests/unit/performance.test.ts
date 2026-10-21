import { describe, expect, it } from 'vitest';

import { dec } from '../../src/core/money/decimal.js';
import type { BusinessDate } from '../../src/core/time/dates.js';
import { liveState, ratingOf } from '../../src/modules/workforce/performance.service.js';

const D = (s: string) => s as BusinessDate;

describe('goal states (Spec P3 §24.2: computed, never keyed)', () => {
  const goal = { startDate: D('2026-01-01'), dueDate: D('2026-12-31') };
  it('overdue after the due date, whatever the progress', () => {
    expect(liveState({ ...goal, progress: dec('99'), hasProgress: true }, D('2027-01-01'))).toBe('overdue');
  });
  it('delayed when progress trails the elapsed time by more than 25 points', () => {
    // 1 October: about 75 % of the year elapsed.
    expect(liveState({ ...goal, progress: dec('40'), hasProgress: true }, D('2026-10-01'))).toBe('delayed');
    expect(liveState({ ...goal, progress: dec('60'), hasProgress: true }, D('2026-10-01'))).toBe(
      'in_progress',
    );
  });
  it('active until the first progress; in progress after', () => {
    expect(liveState({ ...goal, progress: dec('0'), hasProgress: false }, D('2026-02-01'))).toBe('active');
    expect(liveState({ ...goal, progress: dec('5'), hasProgress: true }, D('2026-02-01'))).toBe(
      'in_progress',
    );
  });
});

describe('evaluation ratings', () => {
  it('bands the overall score', () => {
    expect(ratingOf(dec('95'))).toBe('outstanding');
    expect(ratingOf(dec('75'))).toBe('exceeds');
    expect(ratingOf(dec('73.3333'))).toBe('meets');
    expect(ratingOf(dec('40'))).toBe('needs_improvement');
    expect(ratingOf(dec('12'))).toBe('unsatisfactory');
  });
});
