import { describe, expect, it } from 'vitest';

import { parseCsv, readSheet, SheetError, writeSheets } from '../../src/core/imports/sheets.js';

/** P1.17: the spreadsheets of the import framework read every cell as text, and never run a formula. */

describe('csv', () => {
  it('reads quotes, commas, new lines and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",z')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
  });

  it('refuses an unclosed quote and text that is not UTF-8', async () => {
    expect(() => parseCsv('a\n"open')).toThrow(SheetError);
    await expect(readSheet(Buffer.from([0x61, 0x2c, 0xff, 0x0a]), 'csv', 10)).rejects.toThrow(/UTF-8/);
  });

  it('keeps leading zeros, skips empty rows, and limits the rows', async () => {
    const s = await readSheet(Buffer.from('code,name\n007,Bond\n,\n008,Next\n'), 'csv', 10);
    expect(s.rows).toEqual([
      { rowNumber: 2, cells: ['007', 'Bond'] },
      { rowNumber: 4, cells: ['008', 'Next'] },
    ]);
    await expect(readSheet(Buffer.from('a\n1\n2\n'), 'csv', 1)).rejects.toThrow(/more than 1 rows/);
  });
});

describe('writing', () => {
  it('writes a value a spreadsheet would run as a formula as text', async () => {
    const out = (
      await writeSheets([{ name: 'E', header: ['v'], rows: [['=1+1'], ['@SUM(A1)'], ['ok']] }], 'csv')
    ).toString('utf8');
    expect(out).toBe("﻿v\r\n'=1+1\r\n'@SUM(A1)\r\nok\r\n");
  });

  it('round-trips an xlsx with text cells', async () => {
    const x = await writeSheets(
      [{ name: 'Data', header: ['code', 'name'], rows: [['007', 'Bond']] }],
      'xlsx',
    );
    expect(await readSheet(x, 'xlsx', 10)).toEqual({
      header: ['code', 'name'],
      rows: [{ rowNumber: 2, cells: ['007', 'Bond'] }],
    });
  });

  it('refuses a file that is not a workbook', async () => {
    await expect(readSheet(Buffer.from('PK\u0003\u0004nope'), 'xlsx', 10)).rejects.toThrow(SheetError);
  });
});
