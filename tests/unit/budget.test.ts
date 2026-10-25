import { describe, expect, it } from 'vitest';

import { available, utilisation } from '../../src/core/budget/budget.js';
import { dec } from '../../src/core/money/decimal.js';
import { isRelaxation } from '../../src/modules/budget/budget-control.service.js';
import { varianceOf } from '../../src/modules/budget/budget.service.js';

describe('budget figures (P9 §19.2)', () => {
  it('BU.1: available 250,000.00, utilisation 89.5833 %, variance 550,000.00 surplus', () => {
    const [annual, actual, committed] = [dec('2400000'), dec('1850000'), dec('300000')];
    expect(available(annual, actual, committed).toFixed(2)).toBe('250000.00');
    expect(utilisation(annual, actual, committed)?.toFixed(4)).toBe('89.5833');
    expect(varianceOf(annual, actual)).toEqual({ amount: '550000.0000', label: 'surplus' });
  });

  it('an annual of zero is not applicable; an overrun is labelled, never a bare negative', () => {
    expect(utilisation(dec('0'), dec('10'), dec('0'))).toBeNull();
    expect(varianceOf(dec('100'), dec('130'))).toEqual({ amount: '30.0000', label: 'overrun' });
    expect(varianceOf(dec('100'), dec('100')).label).toBe('on_budget');
  });
});

describe('budget control relaxation (D-3.06-10)', () => {
  const c = (
    controlMode: string,
    warning: string | null = null,
    critical: string | null = null,
    tolerance: string | null = null,
  ) => ({
    controlMode,
    warning,
    critical,
    tolerance,
  });
  it('lowering the mode or raising a threshold or the tolerance relaxes; tightening does not', () => {
    expect(isRelaxation(c('warn'), c('block'))).toBe(true);
    expect(isRelaxation(c('block'), c('warn'))).toBe(false);
    expect(isRelaxation(c('warn', '90'), c('warn', '80'))).toBe(true);
    expect(isRelaxation(c('warn', '70'), c('warn', '80'))).toBe(false);
    expect(isRelaxation(c('block', null, null, '5'), c('block'))).toBe(true);
    // Against no control at all, the default is warn.
    expect(isRelaxation(c('none'), null)).toBe(true);
    expect(isRelaxation(c('block'), null)).toBe(false);
  });
});
