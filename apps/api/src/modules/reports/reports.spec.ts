import { classify, normaliseMac } from './classify';
import { csvCell, csvLine, parseCsv } from './csv';

describe('classify', () => {
  it.each([
    ['10.20.10.5', { kind: 'ip', ip: '10.20.10.5' }],
    ['2001:db8::1', { kind: 'ip', ip: '2001:db8::1' }],
    ['10.20.0.0/16', { kind: 'cidr', cidr: '10.20.0.0/16' }],
    ['3C:EC:EF:10:20:30', { kind: 'mac', mac: '3c:ec:ef:10:20:30', alsoText: false }],
    ['3cec.ef10.2030', { kind: 'mac', mac: '3c:ec:ef:10:20:30', alsoText: false }],
    ['3cecef102030', { kind: 'mac', mac: '3c:ec:ef:10:20:30', alsoText: true }],
    ['4c4c4544-0042-3510-8051-b4c04f4b4e32', { kind: 'uuid', id: '4c4c4544-0042-3510-8051-b4c04f4b4e32' }],
    ['esx-01', { kind: 'text', text: 'esx-01' }],
    ['10.1', { kind: 'text', text: '10.1' }],
  ])('%s', (q, expected) => expect(classify(q)).toEqual(expected));

  it('rejects near-MACs', () => {
    expect(normaliseMac('3c:ec:ef:10:20')).toBeNull();
    expect(normaliseMac('zz:ec:ef:10:20:30')).toBeNull();
  });
});

describe('csv', () => {
  it('parses quotes, embedded commas and newlines, CRLF and a BOM', () => {
    const r = parseCsv('﻿Name,Notes\r\n"web, 01","said ""hi""\nthen left"\r\nplain,\r\n\r\n');
    expect(r.header).toEqual(['name', 'notes']);
    expect(r.rows).toEqual([['web, 01', 'said "hi"\nthen left'], ['plain', '']]);
  });

  it('refuses malformed input and oversized files', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/unterminated/);
    expect(() => parseCsv('a\nx"y')).toThrow(/quote inside/);
    expect(() => parseCsv(`a\n${'x\n'.repeat(11)}`, 10)).toThrow(/more than 10 rows/);
  });

  it('neutralises spreadsheet formulas but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-42')).toBe('-42');
    expect(csvLine(['a,b', null, 3])).toBe('"a,b",,3\r\n');
  });
});
