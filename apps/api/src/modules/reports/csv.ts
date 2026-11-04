/**
 * RFC 4180 CSV: quoted fields, doubled quotes, embedded commas and newlines, CRLF or LF, an
 * optional UTF-8 BOM (Excel). Small and strict rather than a dependency.
 */
export function parseCsv(text: string, maxRows = 5000): { header: string[]; rows: string[][] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') out.push(row);
    if (out.length > maxRows + 1) throw new Error(`more than ${maxRows} rows; split the file`);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field !== '') throw new Error(`line ${out.length + 1}: a quote inside an unquoted field`);
      quoted = true;
    } else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') {
      if (src[i + 1] !== '\n') endRow();
    } else field += c;
    i++;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length) endRow();
  const [header = [], ...rows] = out;
  return { header: header.map((h) => h.trim().toLowerCase()), rows };
}

/**
 * One CSV cell. Values starting with = + - @ (or a tab/CR) are prefixed with an apostrophe so a
 * spreadsheet shows them as text instead of executing them (CSV / formula injection).
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(' ') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values: unknown[]) => `${values.map(csvCell).join(',')}\r\n`;
