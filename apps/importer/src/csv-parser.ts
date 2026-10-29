import { Transform, type TransformCallback } from 'node:stream';
import { MAX_RECORD_CHARS } from './line-splitter.ts';

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

/** A parsed row with the 1-based file line it starts on (the header is line 1). */
export interface NumberedRow {
  line: number;
  row: TicketRow;
}

// A quote opens a quoted field only at the start of a field; elsewhere (5" monitor) it is plain text.
function splitFields(record: string): string[] {
  if (!record.includes('"')) return record.split(',');

  const fields: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;

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
    } else if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }

  fields.push(field);

  return fields;
}

// Whether a quoted field is still open at the end of `line`. `quoted` is the state at its start:
// true for a continuation line, false for the first line of a record. Uses the same rules as splitFields.
function endsQuoted(line: string, quoted: boolean): boolean {
  if (!line.includes('"')) return quoted;

  let fieldStart = !quoted;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (quoted) {
      if (ch !== '"') continue;

      if (line[i + 1] === '"') i++;
      else quoted = false;
    } else if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else {
      fieldStart = ch === ',';
    }
  }

  return quoted;
}

// Lines in, ticket rows out. A quoted field may span lines, so lines are joined until quotes balance.
// Field validation lives in RowValidator: a short row gets empty strings, extra fields are dropped.
export class CsvParser extends Transform {
  /** Rows parsed so far, header excluded. */
  rows = 0;
  /** Lines of a record whose quotes are not balanced yet. */
  private pending: string[] | null = null;
  private pendingChars = 0;
  /** True while the pending lines end inside a quoted field. */
  private openQuote = false;
  private lineNo = 0;
  private recordLine = 0;
  private headerSeen = false;

  constructor() {
    super({ objectMode: true });
  }

  override _transform(line: string, _encoding: BufferEncoding, cb: TransformCallback): void {
    this.lineNo++;

    if (this.pending === null) {
      this.recordLine = this.lineNo;
      this.pending = [];
      this.pendingChars = 0;
      this.openQuote = false;
    }

    // Only the new line is scanned, so a long multi-line field costs linear time.
    this.pending.push(line);
    this.pendingChars += line.length + 1;

    this.openQuote = endsQuoted(line, this.openQuote);

    if (this.openQuote) {
      if (this.pendingChars > MAX_RECORD_CHARS) {
        cb(
          new Error(
            `record starting at line ${this.recordLine} is longer than ${MAX_RECORD_CHARS} characters`,
          ),
        );

        return;
      }

      cb();

      return;
    }

    const record = this.pending.join('\n');

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

    cb(null, { line: this.recordLine, row } satisfies NumberedRow);
  }

  override _flush(cb: TransformCallback): void {
    if (this.pending !== null) {
      cb(new Error('unterminated quoted field at end of file'));
    } else if (!this.headerSeen) {
      cb(new Error('CSV file has no header'));
    } else {
      cb();
    }
  }
}
