import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Batcher } from './batcher.ts';
import { CsvParser, type TicketRow } from './csv-parser.ts';
import type { TicketStore } from './db.ts';
import { LineSplitter } from './line-splitter.ts';

export interface ImportProgress {
  processed: number;
  inserted: number;
}

// The callback fires only after the insert resolves, so a slow DB stalls the whole pipeline (backpressure).
export function createDbWriter(
  store: TicketStore,
  importId: string,
  onInserted: (count: number) => void,
): Writable {
  return new Writable({
    objectMode: true,
    highWaterMark: 1,
    write(batch: TicketRow[], _encoding, cb) {
      store.insertBatch(importId, batch).then(() => {
        onInserted(batch.length);
        cb();
      }, cb);
    },
  });
}

export async function runImport(
  filePath: string,
  importId: string,
  store: TicketStore,
  onProgress: (progress: ImportProgress) => void,
  batchSize?: number,
): Promise<ImportProgress> {
  const parser = new CsvParser();
  const progress: ImportProgress = { processed: 0, inserted: 0 };

  await pipeline(
    createReadStream(filePath),
    new LineSplitter(),
    parser,
    new Batcher<TicketRow>(batchSize),
    createDbWriter(store, importId, (count) => {
      progress.inserted += count;
      progress.processed = parser.rows;
      onProgress({ ...progress });
    }),
  );

  progress.processed = parser.rows;
  onProgress({ ...progress });

  return progress;
}
