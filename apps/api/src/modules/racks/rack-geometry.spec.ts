import { facesBlocked, freeSpans, overlaps, placeableStarts, spanOf } from './rack-geometry';

describe('rack geometry', () => {
  it('full depth blocks both faces, half one, zero-U none', () => {
    expect(facesBlocked('full', 'front')).toEqual(['front', 'rear']);
    expect(facesBlocked('half', 'rear')).toEqual(['rear']);
    expect(facesBlocked('zero_u', null)).toEqual([]);
  });

  it('spans are inclusive and overlap at shared edges', () => {
    expect(spanOf(10, 2)).toEqual({ fromU: 10, toU: 11 });
    expect(overlaps(spanOf(10, 2), spanOf(11, 1))).toBe(true);
    expect(overlaps(spanOf(10, 2), spanOf(12, 1))).toBe(false);
  });

  it('computes free spans around devices', () => {
    expect(freeSpans(10, [{ fromU: 3, toU: 4 }, { fromU: 8, toU: 10 }])).toEqual([
      { fromU: 1, toU: 2 },
      { fromU: 5, toU: 7 },
    ]);
    expect(freeSpans(4, [])).toEqual([{ fromU: 1, toU: 4 }]);
    expect(freeSpans(4, [{ fromU: 1, toU: 4 }])).toEqual([]);
  });

  it('only offers starts that fit on every blocked face', () => {
    const occupied = { front: [{ fromU: 3, toU: 3 }], rear: [{ fromU: 6, toU: 6 }] };
    expect(placeableStarts(8, 2, ['front'], occupied)).toEqual([1, 4, 5, 6, 7]);
    expect(placeableStarts(8, 2, ['front', 'rear'], occupied)).toEqual([1, 4, 7]);
    expect(placeableStarts(8, 9, ['front'], occupied)).toEqual([]);
  });
});
