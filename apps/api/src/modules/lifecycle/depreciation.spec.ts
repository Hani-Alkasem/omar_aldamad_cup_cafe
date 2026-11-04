import { addMonths, depreciate, monthsElapsed } from './depreciation';

describe('depreciation', () => {
  it('counts whole months', () => {
    expect(monthsElapsed('2024-01-15', '2024-02-14')).toBe(0);
    expect(monthsElapsed('2024-01-15', '2024-02-15')).toBe(1);
    expect(monthsElapsed('2024-01-31', '2026-01-31')).toBe(24);
    expect(monthsElapsed('2025-01-01', '2024-01-01')).toBe(0);
  });

  it('adds months and clamps to month end', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-11-15', 3)).toBe('2025-02-15');
  });

  it('straight line: equal monthly charges, never below salvage', () => {
    const input = { method: 'straight_line' as const, cost: 12_000, salvage: 2_000, lifeMonths: 60, startDate: '2024-01-01' };
    expect(depreciate(input, '2025-01-01')).toMatchObject({ ageMonths: 12, accumulated: 2000, bookValue: 10000, monthlyCharge: 166.67, fullyDepreciatedOn: '2029-01-01' });
    expect(depreciate(input, '2035-01-01')).toMatchObject({ accumulated: 10000, bookValue: 2000 });
  });

  it('declining balance front-loads and lands exactly on salvage at end of life', () => {
    const input = { method: 'declining_balance' as const, cost: 10_000, salvage: 1_000, lifeMonths: 36, startDate: '2024-01-01' };
    const y1 = depreciate(input, '2025-01-01');
    const sl = depreciate({ ...input, method: 'straight_line' }, '2025-01-01');
    expect(y1.accumulated).toBeGreaterThan(sl.accumulated);
    expect(depreciate(input, '2027-01-01').bookValue).toBe(1000);
    expect(depreciate(input, '2030-01-01').bookValue).toBe(1000);
  });

  it('declining balance with zero salvage still fully depreciates', () => {
    const r = depreciate({ method: 'declining_balance', cost: 3_600, salvage: 0, lifeMonths: 36, startDate: '2024-01-01' }, '2027-06-01');
    expect(r.bookValue).toBe(0);
  });

  it('returns cost as book value when not depreciable', () => {
    expect(depreciate({ method: 'none', cost: 500, salvage: 0, lifeMonths: null, startDate: '2024-01-01' }, '2026-01-01')).toMatchObject({ bookValue: 500, accumulated: 0 });
    expect(depreciate({ method: 'straight_line', cost: 500, salvage: 0, lifeMonths: 12, startDate: null }, '2026-01-01').bookValue).toBe(500);
  });
});
