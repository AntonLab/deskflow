import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CsvParser, type TicketRow } from '../src/csv-parser.ts';

const HEADER = 'external_id,subject,description,requester_email,priority,status,created_at,tags';

async function parse(lines: string[]): Promise<TicketRow[]> {
  const rows: TicketRow[] = [];

  for await (const row of Readable.from(lines).pipe(new CsvParser())) rows.push(row as TicketRow);

  return rows;
}

describe('CsvParser', () => {
  it('maps columns by position and skips the header', async () => {
    const rows = await parse([HEADER, '1,Sub,Desc,a@b.c,high,open,2024-01-01T00:00:00Z,x;y']);

    expect(rows).toEqual([
      {
        external_id: '1',
        subject: 'Sub',
        description: 'Desc',
        requester_email: 'a@b.c',
        priority: 'high',
        status: 'open',
        created_at: '2024-01-01T00:00:00Z',
        tags: 'x;y',
      },
    ]);
  });

  it('handles commas and escaped quotes inside quoted fields', async () => {
    const [row] = await parse([HEADER, '1,"Hello, ""world""",Περιγραφή,a@b.c,low,new,t,']);

    expect(row?.subject).toBe('Hello, "world"');
    expect(row?.description).toBe('Περιγραφή');
    expect(row?.tags).toBe('');
  });

  it('joins a quoted field that spans lines', async () => {
    const rows = await parse([HEADER, '1,s,"line one', 'line two",a@b.c,low,new,t,g', '2,s,d,e,p,s,t,g']);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.description).toBe('line one\nline two');
    expect(rows[1]?.external_id).toBe('2');
  });

  it('pads short rows with empty strings and skips blank lines', async () => {
    const rows = await parse([HEADER, '', '1,s']);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('');
  });

  it('counts parsed rows without the header', async () => {
    const parser = new CsvParser();

    for await (const row of Readable.from([HEADER, '1,s', '2,s']).pipe(parser)) void row;
    expect(parser.rows).toBe(2);
  });

  it('rejects an unexpected header', async () => {
    await expect(parse(['id,subject', '1,s'])).rejects.toThrow(/unexpected CSV header/);
  });

  it('rejects an unterminated quoted field', async () => {
    await expect(parse([HEADER, '1,"oops'])).rejects.toThrow(/unterminated/);
  });
});
