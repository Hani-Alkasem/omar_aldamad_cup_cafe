import { expandTargets } from '../src/targets';

describe('expandTargets', () => {
  it('skips IPv4 network and broadcast except on /31 and /32', () => {
    expect([...expandTargets(['10.0.0.0/30'], 100)]).toEqual(['10.0.0.1', '10.0.0.2']);
    expect([...expandTargets(['10.0.0.0/31'], 100)]).toEqual(['10.0.0.0', '10.0.0.1']);
    expect([...expandTargets(['10.0.0.9/32'], 100)]).toEqual(['10.0.0.9']);
  });

  it('dedupes overlapping targets and honours the cap lazily', () => {
    expect([...expandTargets(['10.0.0.0/30', '10.0.0.2/32'], 100)]).toEqual(['10.0.0.1', '10.0.0.2']);
    const it = expandTargets(['10.0.0.0/8'], 3);
    expect([...it]).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('expands small IPv6 ranges', () => {
    expect([...expandTargets(['2001:db8::/126'], 100)]).toEqual(['2001:db8::', '2001:db8::1', '2001:db8::2', '2001:db8::3']);
  });
});
