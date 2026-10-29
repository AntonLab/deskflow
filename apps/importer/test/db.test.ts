import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TicketRow } from '../src/csv-parser.ts';
import { createPgStore, ensureSchema } from '../src/db.ts';

// Runs against a real Postgres (CI provides one). Rows use random ids and are removed afterwards.
describe.skipIf(!process.env.DATABASE_URL)('Postgres store', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const store = createPgStore(pool);
  const tag = randomUUID();
  const importId = randomUUID();
  const row = (n: number, subject = 's'): TicketRow => ({
    external_id: `${tag}-${n}`,
    subject,
    description: 'quote " comma , \n newline',
    requester_email: 'a@b.co',
    priority: 'low',
    status: 'new',
    created_at: '2024-01-01T00:00:00Z',
    tags: '',
  });
  const count = async () =>
    Number(
      (await pool.query('SELECT count(*) AS c FROM imported_tickets WHERE import_id = $1', [importId]))
        .rows[0].c,
    );

  beforeAll(() => ensureSchema(pool));
  afterAll(async () => {
    await store.deleteImport(importId);
    await pool.end();
  });

  it('stores rows with special characters and counts only the new ones', async () => {
    await store.startImport(importId, 'acme');
    expect(await store.insertBatch(importId, [row(1), row(2)])).toBe(2);
    expect(await store.insertBatch(importId, [row(2), row(3), row(3)])).toBe(1);
    expect(await count()).toBe(3);
  });

  it('lets two tenants hold the same external_id', async () => {
    const other = randomUUID();

    await store.startImport(other, 'globex');
    expect(await store.insertBatch(other, [row(1)])).toBe(1);
    await store.deleteImport(other);
    await store.endImport(other);
  });

  it('refuses rows of an import that was never started', async () => {
    await expect(store.insertBatch(randomUUID(), [row(1)])).rejects.toThrow(/not started/);
  });

  it('removes every row of an import', async () => {
    await store.deleteImport(importId);

    expect(await count()).toBe(0);
  });

  it('discards the rows of imports left running by a dead process, and keeps finished ones', async () => {
    const dead = randomUUID();
    const done = randomUUID();
    const inserted = (id: string) =>
      pool
        .query('SELECT count(*) AS c FROM imported_tickets WHERE import_id = $1', [id])
        .then((r) => Number(r.rows[0].c));

    await store.startImport(dead, 'acme');
    await store.insertBatch(dead, [row(21)]);
    await store.startImport(done, 'acme');
    await store.insertBatch(done, [row(22)]);
    await store.endImport(done);

    expect(await store.discardInterrupted()).toBeGreaterThanOrEqual(1);
    expect(await inserted(dead)).toBe(0);
    expect(await inserted(done)).toBe(1);

    await store.deleteImport(done);
  });

  it('cannot store a NUL character, which the validator keeps out', async () => {
    await expect(store.insertBatch(importId, [row(9, 'a\0b')])).rejects.toThrow(/0x00/);
  });
});
