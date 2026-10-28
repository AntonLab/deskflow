import type { Pool } from 'pg';
import { CSV_COLUMNS, type TicketRow } from './csv-parser.ts';

export interface TicketStore {
  insertBatch(importId: string, rows: TicketRow[]): Promise<void>;
}

// Minimal schema; the full one arrives in module 3. Values stay text until DF-003 validates them.
export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS imported_tickets (
      id              bigserial PRIMARY KEY,
      import_id       uuid NOT NULL,
      external_id     text NOT NULL,
      subject         text NOT NULL,
      description     text NOT NULL,
      requester_email text NOT NULL,
      priority        text NOT NULL,
      status          text NOT NULL,
      created_at      text NOT NULL,
      tags            text NOT NULL
    )`);
}

// One multi-row INSERT. Postgres allows 65535 parameters, so 9 per row fits ~7000 rows.
export function buildInsert(importId: string, rows: TicketRow[]): { text: string; values: string[] } {
  const width = CSV_COLUMNS.length + 1;
  const values: string[] = [];
  const tuples = rows.map((row, r) => {
    values.push(importId, ...CSV_COLUMNS.map((name) => row[name]));

    return `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`;
  });

  return {
    text: `INSERT INTO imported_tickets (import_id, ${CSV_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`,
    values,
  };
}

export function createPgStore(pool: Pool): TicketStore {
  return {
    async insertBatch(importId, rows) {
      const { text, values } = buildInsert(importId, rows);

      await pool.query(text, values);
    },
  };
}
