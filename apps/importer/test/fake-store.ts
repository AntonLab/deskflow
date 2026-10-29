import type { TicketStore } from '../src/db.ts';
import type { TicketRow } from '../src/csv-parser.ts';

// A store that keeps nothing: `onInsert` sees every batch, and every row counts as stored.
export function fakeStore(
  onInsert: (importId: string, rows: TicketRow[]) => unknown = () => {},
): TicketStore {
  return {
    async insertBatch(importId, rows) {
      await onInsert(importId, rows);

      return rows.length;
    },
    async deleteImport() {},
    async startImport() {},
    async endImport() {},
    async discardInterrupted() {
      return 0;
    },
  };
}
