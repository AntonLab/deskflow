import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CsvParser, type NumberedRow } from '../src/csv-parser.ts';

const HEADER = 'external_id,subject,description,requester_email,priority,status,created_at,tags';

async function parse(lines: string[]): Promise<NumberedRow[]> {
  const rows: NumberedRow[] = [];

  for await (const row of Readable.from(lines).pipe(new CsvParser())) rows.push(row as NumberedRow);

  return rows;
}

describe('CsvParser', () => {
  it('maps columns by position and skips the header', async () => {
    const rows = await parse([HEADER, '1,Sub,Desc,a@b.c,high,open,2024-01-01T00:00:00Z,x;y']);

    expect(rows).toEqual([
      {
        line: 2,
        row: {
          external_id: '1',
          subject: 'Sub',
          description: 'Desc',
          requester_email: 'a@b.c',
          priority: 'high',
          status: 'open',
          created_at: '2024-01-01T00:00:00Z',
          tags: 'x;y',
        },
      },
    ]);
  });

  it('handles commas and escaped quotes inside quoted fields', async () => {
    const [first] = await parse([HEADER, '1,"Hello, ""world""",Περιγραφή,a@b.c,low,new,t,']);

    expect(first?.row.subject).toBe('Hello, "world"');
    expect(first?.row.description).toBe('Περιγραφή');
    expect(first?.row.tags).toBe('');
  });

  it('joins a quoted field that spans lines and numbers the row by its first line', async () => {
    const rows = await parse([HEADER, '1,s,"line one', 'line two",a@b.c,low,new,t,g', '2,s,d,e,p,s,t,g']);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.row.description).toBe('line one\nline two');
    expect(rows[1]?.row.external_id).toBe('2');
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
  });

  it('pads short rows with empty strings and skips blank lines, which still count as lines', async () => {
    const rows = await parse([HEADER, '', '1,s']);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.row.description).toBe('');
    expect(rows[0]?.line).toBe(3);
  });

  it('counts parsed rows without the header', async () => {
    const parser = new CsvParser();

    for await (const row of Readable.from([HEADER, '1,s', '2,s']).pipe(parser)) void row;
    expect(parser.rows).toBe(2);
  });

  it('rejects an unexpected header', async () => {
    await expect(parse(['id,subject', '1,s'])).rejects.toThrow(/unexpected CSV header/);
  });

  it('fails fast on a stray quote instead of buffering the rest of the file', async () => {
    const lines = [HEADER, '1,"never closed,d,a@b.co,low,new,2024-01-01T00:00:00Z,'];

    for (let i = 2; i < 40_000; i++)
      lines.push(`${i},subject ${'x'.repeat(60)},d,a@b.co,low,new,2024-01-01T00:00:00Z,`);

    const t0 = Date.now();

    await expect(parse(lines)).rejects.toThrow(/longer than/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('treats a quote inside an unquoted value as text and keeps the following rows apart', async () => {
    const rows = await parse([
      HEADER,
      '1,Screen 5" wide,d,a@b.co,low,new,2024-01-01T00:00:00Z,',
      '2,B,d,b@b.co,low,new,2024-01-01T00:00:00Z,',
      '3,Say "hi" now",d,c@b.co,low,new,2024-01-01T00:00:00Z,',
      '4,"quoted, ""ok""",d,d@b.co,low,new,2024-01-01T00:00:00Z,',
    ]);

    expect(rows.map((r) => [r.line, r.row.subject])).toEqual([
      [2, 'Screen 5" wide'],
      [3, 'B'],
      [4, 'Say "hi" now"'],
      [5, 'quoted, "ok"'],
    ]);
  });

  it('joins a long quoted field in linear time', async () => {
    const lines = [HEADER, '1,s,"start'];

    for (let i = 0; i < 20_000; i++) lines.push(`line ${i} of the description`);

    lines.push('end",a@b.co,low,new,2024-01-01T00:00:00Z,');

    const t0 = Date.now();
    const rows = await parse(lines);

    expect(rows).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('rejects a file without a header', async () => {
    await expect(parse([])).rejects.toThrow(/no header/);
    await expect(parse(['', ''])).rejects.toThrow(/no header/);
  });

  it('rejects an unterminated quoted field', async () => {
    await expect(parse([HEADER, '1,"oops'])).rejects.toThrow(/unterminated/);
  });
});
