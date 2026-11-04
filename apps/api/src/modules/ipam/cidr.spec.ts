import { DomainError } from '../../common/errors';
import { parseCidrStrict, parseIp, usableHosts, utilisationPct } from './cidr';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as DomainError).code;
  }
  return 'NO_ERROR';
};

describe('CIDR validation', () => {
  it('normalises valid IPv4 and IPv6 networks', () => {
    expect(parseCidrStrict(' 10.0.0.0/24 ')).toMatchObject({ cidr: '10.0.0.0/24', family: 4, prefix: 24, broadcast: '10.0.0.255' });
    expect(parseCidrStrict('2001:DB8::/48')).toMatchObject({ cidr: '2001:db8::/48', family: 6, prefix: 48 });
    expect(parseCidrStrict('0.0.0.0/0').cidr).toBe('0.0.0.0/0');
  });

  it('rejects host bits with a suggestion', () => {
    try {
      parseCidrStrict('10.0.0.5/24');
      throw new Error('expected rejection');
    } catch (e) {
      expect((e as DomainError).code).toBe('CIDR_HOST_BITS_SET');
      expect((e as DomainError).details).toEqual({ suggestion: '10.0.0.0/24' });
    }
    expect(codeOf(() => parseCidrStrict('2001:db8::1/64'))).toBe('CIDR_HOST_BITS_SET');
  });

  it('rejects malformed input', () => {
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '300.0.0.0/8', 'abc/24', '::ffff:10.0.0.0/120', '10.1/16', '0x0a.0.0.0/8']) {
      expect(codeOf(() => parseCidrStrict(bad))).toBe('CIDR_INVALID');
    }
  });

  it('counts usable hosts per RFC 3021', () => {
    expect(usableHosts(4, 24)).toBe(254n);
    expect(usableHosts(4, 31)).toBe(2n);
    expect(usableHosts(4, 32)).toBe(1n);
    expect(usableHosts(6, 64)).toBe(18446744073709551616n);
  });

  it('computes utilisation without overflowing on IPv6', () => {
    expect(utilisationPct(127, 254n)).toBe(50);
    expect(utilisationPct(10, usableHosts(6, 64))).toBe(0);
  });

  it('parses single addresses', () => {
    expect(parseIp('10.0.0.7/32')).toEqual({ ip: '10.0.0.7', family: 4 });
    expect(parseIp('::ffff:10.0.0.7')).toEqual({ ip: '10.0.0.7', family: 4 });
    expect(codeOf(() => parseIp('10.0.0'))).toBe('IP_INVALID');
    expect(codeOf(() => parseIp('010.0.0.1'))).toBe('IP_INVALID');
  });
});
