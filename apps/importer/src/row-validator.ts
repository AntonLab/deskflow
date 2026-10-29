import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { Transform, type TransformCallback } from 'node:stream';
import type { NumberedRow } from './csv-parser.ts';
import { type RowError, validateRow } from './row-schema.ts';

export const MAX_ERRORS = 10_000;

export class TooManyErrorsError extends Error {
  constructor(limit: number) {
    super(`more than ${limit} invalid values, import aborted`);
  }
}

// Streams errors to an NDJSON file, one `{ line, field, message }` per line. The file is created on the first error.
// A write failure (disk full, folder gone) is kept and thrown by the next `add` or by `close`, so it fails the import.
export class ErrorReport {
  /** Errors written so far. */
  count = 0;
  private out: WriteStream | null = null;
  private failure: Error | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async add(errors: RowError[]): Promise<void> {
    if (this.failure) throw this.failure;

    if (!this.out) {
      this.out = createWriteStream(this.path);
      this.out.on('error', (err) => {
        this.failure = err;
      });
    }

    this.count += errors.length;

    if (!this.out.write(errors.map((e) => JSON.stringify(e) + '\n').join(''))) {
      await once(this.out, 'drain');
    }
  }

  // Flushes pending writes. After a failure or cancel the caller deletes the file.
  async close(): Promise<void> {
    const out = this.out;

    if (!out) return;

    if (!out.destroyed) {
      out.end();
      await once(out, 'close').catch(() => {});
    }

    if (this.failure) throw this.failure;
  }
}

// Numbered rows in, valid rows out. Invalid rows go to the report and never reach the DB.
export class RowValidator extends Transform {
  /** Rows rejected so far. */
  rejected = 0;

  private readonly report: ErrorReport;
  private readonly maxErrors: number;

  constructor(report: ErrorReport, maxErrors = MAX_ERRORS) {
    super({ objectMode: true });
    this.report = report;
    this.maxErrors = maxErrors;
  }

  override _transform(item: NumberedRow, _encoding: BufferEncoding, cb: TransformCallback): void {
    const result = validateRow(item.line, item.row);

    if ('row' in result) {
      cb(null, result.row);

      return;
    }

    this.rejected++;
    this.report.add(result.errors).then(() => {
      cb(this.report.count > this.maxErrors ? new TooManyErrorsError(this.maxErrors) : null);
    }, cb);
  }
}
