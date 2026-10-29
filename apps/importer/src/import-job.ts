import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Batcher } from './batcher.ts';
import { CsvParser, type TicketRow } from './csv-parser.ts';
import type { TicketStore } from './db.ts';
import { LineSplitter } from './line-splitter.ts';
import { ErrorReport, RowValidator } from './row-validator.ts';

export interface ImportProgress {
  processed: number;
  inserted: number;
  /** Rows skipped because they failed validation. */
  rejected: number;
  /** Valid rows skipped because their `external_id` is already stored. */
  duplicates: number;
}

export interface ImportOptions {
  batchSize?: number;
  /** Aborting the signal destroys every stream and rejects with an AbortError. */
  signal?: AbortSignal;
  /** NDJSON file for the validation report; created on the first invalid row. */
  errorsPath: string;
  maxErrors?: number;
}

// The callback fires only after the insert resolves, so a slow DB stalls the whole pipeline (backpressure).
// A batch that finishes after the writer was destroyed is not counted; the caller waits for it before cleaning up.
export function createDbWriter(
  store: TicketStore,
  importId: string,
  onInserted: (inserted: number, batchSize: number) => void,
): Writable {
  const writer = new Writable({
    objectMode: true,
    highWaterMark: 1,
    write(batch: TicketRow[], _encoding, cb) {
      void store.insertBatch(importId, batch).then((inserted) => {
        if (writer.destroyed) return;

        onInserted(inserted, batch.length);
        cb();
      }, cb);
    },
  });

  return writer;
}

// Text length stands in for bytes; it keeps a batch of long descriptions small.
const rowWeight = (row: TicketRow): number =>
  Object.values(row).reduce((sum, value) => sum + value.length, 0);

export async function runImport(
  filePath: string,
  importId: string,
  store: TicketStore,
  onProgress: (progress: ImportProgress) => void,
  options: ImportOptions,
): Promise<ImportProgress> {
  const parser = new CsvParser();
  const report = new ErrorReport(options.errorsPath);
  const validator = new RowValidator(report, options.maxErrors);
  const progress: ImportProgress = { processed: 0, inserted: 0, rejected: 0, duplicates: 0 };
  const snapshot = (): ImportProgress => {
    progress.processed = parser.rows;
    progress.rejected = validator.rejected;

    return { ...progress };
  };

  try {
    await pipeline(
      createReadStream(filePath),
      new LineSplitter(),
      parser,
      validator,
      new Batcher<TicketRow>(options.batchSize, rowWeight),
      createDbWriter(store, importId, (inserted, batchSize) => {
        progress.inserted += inserted;
        progress.duplicates += batchSize - inserted;
        onProgress(snapshot());
      }),
      { signal: options.signal },
    );
  } finally {
    await report.close();
  }

  onProgress(snapshot());

  return snapshot();
}
