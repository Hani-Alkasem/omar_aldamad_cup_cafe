import type { DepreciationMethod, DepreciationSummary } from '@itam/shared';

export interface DepreciationInput {
  method: DepreciationMethod;
  cost: number | null;
  salvage: number;
  lifeMonths: number | null;
  /** Depreciation starts when the asset enters service (falls back to purchase date). */
  startDate: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whole calendar months from `from` to `to` (0 if `to` is earlier). */
export function monthsElapsed(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(0, months);
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/**
 * Book value at `asOf`.
 * - straight_line: equal monthly charges of (cost − salvage) / life.
 * - declining_balance: double-declining (monthly rate 2 / life) that switches to straight-line
 *   on the remaining base once that is larger, so it lands exactly on salvage at end of life.
 */
export function depreciate(input: DepreciationInput, asOf: string): DepreciationSummary {
  const { method, cost, salvage, lifeMonths, startDate } = input;
  const ageMonths = startDate ? monthsElapsed(startDate, asOf) : 0;
  const base: DepreciationSummary = { method, cost, salvage, ageMonths, accumulated: 0, bookValue: cost, monthlyCharge: null, fullyDepreciatedOn: null };
  if (method === 'none' || cost == null || !lifeMonths || !startDate) return base;

  const depreciable = cost - salvage;
  const fullyDepreciatedOn = addMonths(startDate, lifeMonths);
  const months = Math.min(ageMonths, lifeMonths);

  if (method === 'straight_line') {
    const monthly = depreciable / lifeMonths;
    const accumulated = round2(Math.min(depreciable, monthly * months));
    return { ...base, accumulated, bookValue: round2(cost - accumulated), monthlyCharge: round2(monthly), fullyDepreciatedOn };
  }

  const rate = 2 / lifeMonths;
  let book = cost;
  let charge = 0;
  for (let m = 0; m < months; m++) {
    const remaining = lifeMonths - m;
    const ddb = book * rate;
    const sl = (book - salvage) / remaining;
    charge = Math.min(Math.max(ddb, sl), book - salvage);
    book -= charge;
  }
  const nextCharge = months < lifeMonths ? Math.max(book * rate, (book - salvage) / (lifeMonths - months)) : 0;
  return {
    ...base,
    accumulated: round2(cost - book),
    bookValue: round2(book),
    monthlyCharge: round2(months < lifeMonths ? Math.min(nextCharge, book - salvage) : 0),
    fullyDepreciatedOn,
  };
}
