import ExcelJS from 'exceljs';

/**
 * Reading and writing the spreadsheets of the import framework (P1.17): .xlsx (the SRS's "Excel import")
 * and .csv. Every cell is read as TEXT, exactly as the user typed it; the import type decides what the
 * text means, so "007" stays "007" and a date is never guessed.
 */

export type SheetFormat = 'xlsx' | 'csv';

export interface ReadSheet {
  /** The header row, trimmed. */
  readonly header: readonly string[];
  /** Data rows from row 2, each as text per header column; fully empty rows are skipped. */
  readonly rows: readonly { readonly rowNumber: number; readonly cells: readonly string[] }[];
}

export class SheetError extends Error {}

/** A cell as the user sees it: a formula's result, a date as yyyy-mm-dd, rich text joined. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    return '';
  }
  return String(v);
}

async function readXlsx(buffer: Buffer, maxRows: number): Promise<ReadSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new SheetError('The file is not a readable .xlsx workbook.');
  }
  // The data sheet is the first; a template's "Instructions" sheet comes after it.
  const ws = wb.worksheets[0];
  if (!ws) throw new SheetError('The workbook has no sheet.');
  const header: string[] = [];
  const rows: { rowNumber: number; cells: string[] }[] = [];
  let width = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const values = row.values as ExcelJS.CellValue[]; // 1-based
    if (n === 1) {
      for (let c = 1; c < values.length; c += 1) header.push(cellText(values[c]).trim());
      while (header.length > 0 && header[header.length - 1] === '') header.pop();
      width = header.length;
      return;
    }
    const cells = Array.from({ length: width }, (_, i) => cellText(values[i + 1]).trim());
    if (cells.every((c) => c === '')) return;
    if (rows.length >= maxRows) throw new SheetError(`The file has more than ${String(maxRows)} rows.`);
    rows.push({ rowNumber: n, cells });
  });
  return { header, rows };
}

/** RFC 4180: comma-separated, "quoted" fields with "" for a quote, CRLF or LF. A UTF-8 BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new SheetError('A quoted value in the file is never closed.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

function readCsv(buffer: Buffer, maxRows: number): ReadSheet {
  const text = buffer.toString('utf8');
  if (text.includes('\u0000') || text.includes('�'))
    throw new SheetError('The file is not UTF-8 text. Save it as "CSV UTF-8".');
  const lines = parseCsv(text);
  const [first, ...rest] = lines;
  const header = (first ?? []).map((h) => h.trim());
  while (header.length > 0 && header[header.length - 1] === '') header.pop();
  const rows: { rowNumber: number; cells: string[] }[] = [];
  rest.forEach((line, i) => {
    const cells = Array.from({ length: header.length }, (_, c) => (line[c] ?? '').trim());
    if (cells.every((c) => c === '')) return;
    if (rows.length >= maxRows) throw new SheetError(`The file has more than ${String(maxRows)} rows.`);
    rows.push({ rowNumber: i + 2, cells });
  });
  return { header, rows };
}

export async function readSheet(buffer: Buffer, format: SheetFormat, maxRows: number): Promise<ReadSheet> {
  return format === 'xlsx' ? readXlsx(buffer, maxRows) : readCsv(buffer, maxRows);
}

// ---- writing ----------------------------------------------------------------------------------------

/** A value that a spreadsheet would run as a formula is written as text (CSV injection). */
function safe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function csvField(v: string): string {
  const s = safe(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface SheetSpec {
  readonly name: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * Writes sheets as .xlsx (all of them) or .csv (the first only, with a BOM so Excel reads UTF-8). Every
 * cell is text, so a code like "007" survives the round trip.
 */
export async function writeSheets(sheets: readonly SheetSpec[], format: SheetFormat): Promise<Buffer> {
  if (format === 'csv') {
    const [first] = sheets;
    const lines = [first?.header ?? [], ...(first?.rows ?? [])].map((r) => r.map(csvField).join(','));
    return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RupAI';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow([...s.header]).font = { bold: true };
    for (const r of s.rows) ws.addRow(r.map(safe));
    ws.columns.forEach((c, i) => {
      c.numFmt = '@';
      const longest = Math.max(
        (s.header[i] ?? '').length,
        ...s.rows.slice(0, 200).map((r) => (r[i] ?? '').length),
      );
      c.width = Math.min(60, Math.max(10, longest + 2));
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const SHEET_MIME: Readonly<Record<SheetFormat, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};
