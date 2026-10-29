import type { Pool } from 'pg';
import { CSV_COLUMNS, type TicketRow } from './csv-parser.ts';

export interface TicketStore {
  /**
   * Resolves with the number of rows stored; rows whose `external_id` already exists for the import's tenant
   * are skipped. The import must have been started with `startImport`.
   */
  insertBatch(importId: string, rows: TicketRow[]): Promise<number>;
  /** Removes every row the import stored. */
  deleteImport(importId: string): Promise<void>;
  /** Marks an import as running and binds it to the tenant that owns its rows. A process that dies leaves the mark behind. */
  startImport(importId: string, tenantId: string): Promise<void>;
  /** Removes the mark once the import is finished and cleaned up. */
  endImport(importId: string): Promise<void>;
  /**
   * Deletes the rows of imports still marked running and clears the marks. Call it once at startup:
   * it assumes a single importer instance, since another instance's running imports look the same.
   */
  discardInterrupted(): Promise<number>;
}

// Minimal schema; the full one arrives in module 3. Values are validated but still stored as text.
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
  await pool.query(
    'CREATE INDEX IF NOT EXISTS imported_tickets_import_id_idx ON imported_tickets (import_id)',
  );
  // Rows stored before tenants existed belong to the 'default' tenant.
  await pool.query(
    "ALTER TABLE imported_tickets ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default'",
  );
  await pool.query('ALTER TABLE imported_tickets ALTER COLUMN tenant_id DROP DEFAULT');
  await pool.query('DROP INDEX IF EXISTS imported_tickets_external_id_key');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS imported_tickets_tenant_external_id_key ON imported_tickets (tenant_id, external_id)',
  );
  await pool.query('CREATE TABLE IF NOT EXISTS running_imports (import_id uuid PRIMARY KEY)');
}

// One multi-row INSERT. Postgres allows 65535 parameters, so 10 per row fits ~6500 rows.
export function buildInsert(
  tenantId: string,
  importId: string,
  rows: TicketRow[],
): { text: string; values: string[] } {
  const width = CSV_COLUMNS.length + 2;
  const values: string[] = [];
  const tuples = rows.map((row, r) => {
    values.push(importId, tenantId, ...CSV_COLUMNS.map((name) => row[name]));

    return `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`;
  });

  return {
    text: `INSERT INTO imported_tickets (import_id, tenant_id, ${CSV_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (tenant_id, external_id) DO NOTHING`,
    values,
  };
}

export function createPgStore(pool: Pool): TicketStore {
  // Which tenant owns the rows of each running import; set by `startImport`.
  const tenants = new Map<string, string>();

  return {
    async insertBatch(importId, rows) {
      const tenantId = tenants.get(importId);

      if (tenantId === undefined) throw new Error(`import ${importId} was not started`);

      const { text, values } = buildInsert(tenantId, importId, rows);

      const result = await pool.query(text, values);

      return result.rowCount ?? 0;
    },
    async deleteImport(importId) {
      await pool.query('DELETE FROM imported_tickets WHERE import_id = $1', [importId]);
    },
    async startImport(importId, tenantId) {
      tenants.set(importId, tenantId);
      await pool.query('INSERT INTO running_imports (import_id) VALUES ($1) ON CONFLICT DO NOTHING', [
        importId,
      ]);
    },
    async endImport(importId) {
      tenants.delete(importId);
      await pool.query('DELETE FROM running_imports WHERE import_id = $1', [importId]);
    },
    async discardInterrupted() {
      await pool.query(
        'DELETE FROM imported_tickets WHERE import_id IN (SELECT import_id FROM running_imports)',
      );

      const { rowCount } = await pool.query('DELETE FROM running_imports');

      return rowCount ?? 0;
    },
  };
}
