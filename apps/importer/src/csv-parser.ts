import { Transform, type TransformCallback } from 'node:stream';

export const CSV_COLUMNS = [
  'external_id',
  'subject',
  'description',
  'requester_email',
  'priority',
  'status',
  'created_at',
  'tags',
] as const;

export type TicketRow = Record<(typeof CSV_COLUMNS)[number], string>;

function splitFields(record: string): string[] {
  if (!record.includes('"')) return record.split(',');

  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < record.length; i++) {
    const ch = record[i]!;

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (record[i + 1] === '"') {
        field += '"';

        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }

  fields.push(field);

  return fields;
}

// Lines in, ticket rows out. A quoted field may span lines, so lines are joined until quotes balance.
// Field validation is out of scope (DF-003): a short row gets empty strings, extra fields are dropped.
export class CsvParser extends Transform {
  /** Rows parsed so far, header excluded. */
  rows = 0;
  private pending: string | null = null;
  private headerSeen = false;

  constructor() {
    super({ objectMode: true });
  }

  override _transform(line: string, _encoding: BufferEncoding, cb: TransformCallback): void {
    const record = this.pending === null ? line : `${this.pending}\n${line}`;

    if (countQuotes(record) % 2 === 1) {
      this.pending = record;
      cb();

      return;
    }

    this.pending = null;

    if (record === '') {
      cb();

      return;
    }

    const fields = splitFields(record);

    if (!this.headerSeen) {
      this.headerSeen = true;

      if (CSV_COLUMNS.some((name, i) => fields[i]?.trim() !== name)) {
        cb(new Error(`unexpected CSV header, expected: ${CSV_COLUMNS.join(',')}`));

        return;
      }

      cb();

      return;
    }

    const row = {} as TicketRow;

    CSV_COLUMNS.forEach((name, i) => {
      row[name] = fields[i] ?? '';
    });

    this.rows++;

    cb(null, row);
  }

  override _flush(cb: TransformCallback): void {
    cb(this.pending === null ? null : new Error('unterminated quoted field at end of file'));
  }
}

function countQuotes(text: string): number {
  let n = 0;

  for (let i = text.indexOf('"'); i !== -1; i = text.indexOf('"', i + 1)) n++;

  return n;
}
