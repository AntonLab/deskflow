import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Batcher } from '../src/batcher.ts';
import { buildInsert, type TicketStore } from '../src/db.ts';
import type { TicketRow } from '../src/csv-parser.ts';
import { createDbWriter, type ImportProgress, runImport } from '../src/import-job.ts';

const HEADER = 'external_id,subject,description,requester_email,priority,status,created_at,tags\n';

function goodLine(i: number): string {
  return `${i},Ticket ${i},d,a@b.co,low,new,2024-01-01T00:00:00Z,`;
}

function row(i: number): TicketRow {
  return {
    external_id: String(i),
    subject: `s${i}`,
    description: 'd',
    requester_email: 'a@b.c',
    priority: 'low',
    status: 'new',
    created_at: 't',
    tags: '',
  };
}

describe('buildInsert', () => {
  it('builds one multi-row INSERT with numbered parameters', () => {
    const { text, values } = buildInsert('imp', [row(1), row(2)]);

    expect(text).toBe(
      'INSERT INTO imported_tickets (import_id, external_id, subject, description, requester_email, priority, status, created_at, tags) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18)',
    );
    expect(values).toHaveLength(18);
    expect(values.slice(0, 3)).toEqual(['imp', '1', 's1']);
    expect(values[9]).toBe('imp');
  });
});

describe('Batcher', () => {
  it('emits full batches and a shorter final one', async () => {
    const sizes: number[] = [];
    const source = Readable.from(Array.from({ length: 25 }, (_, i) => i));

    await pipeline(source, new Batcher<number>(10), async function (batches: AsyncIterable<number[]>) {
      for await (const batch of batches) sizes.push(batch.length);
    });
    expect(sizes).toEqual([10, 10, 5]);
  });
});

describe('backpressure', () => {
  it('stops reading while the store is slow, so memory stays bounded', async () => {
    const total = 20_000;
    const batchSize = 100;
    let produced = 0;
    let inserted = 0;
    let maxAhead = 0;
    const store: TicketStore = {
      async insertBatch(_id, rows) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        inserted += rows.length;
      },
    };
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < total; i++) {
          produced++;
          maxAhead = Math.max(maxAhead, produced - inserted);
          yield row(i);
        }
      })(),
    );

    await pipeline(
      source,
      new Batcher<TicketRow>(batchSize),
      createDbWriter(store, 'imp', () => {}),
    );

    expect(inserted).toBe(total);
    // Without backpressure the source would run to 20 000 almost at once.
    expect(maxAhead).toBeLessThan(total / 10);
  });
});

describe('runImport', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deskflow-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('inserts every row in batches and reports progress', async () => {
    const file = join(dir, 'a.csv');
    const lines = Array.from({ length: 2500 }, (_, i) => goodLine(i));

    writeFileSync(file, HEADER + lines.join('\n') + '\n');

    const batches: number[] = [];
    const store: TicketStore = {
      async insertBatch(_id, rows) {
        batches.push(rows.length);
      },
    };
    const seen: ImportProgress[] = [];
    const errors = join(dir, 'a.errors.ndjson');
    const result = await runImport(file, 'imp', store, (p) => seen.push(p), {
      batchSize: 1000,
      errorsPath: errors,
    });

    expect(batches).toEqual([1000, 1000, 500]);
    expect(result).toEqual({ processed: 2500, inserted: 2500, rejected: 0 });
    expect(seen.at(-1)).toEqual(result);
    expect(existsSync(errors)).toBe(false);
  });

  it('rejects when an insert fails', async () => {
    const file = join(dir, 'b.csv');

    writeFileSync(file, HEADER + goodLine(1) + '\n');

    const store: TicketStore = {
      insertBatch: () => Promise.reject(new Error('db down')),
    };

    await expect(
      runImport(file, 'imp', store, () => {}, { errorsPath: join(dir, 'b.errors.ndjson') }),
    ).rejects.toThrow('db down');
  });

  it('skips invalid rows and reports each with its line and field', async () => {
    const file = join(dir, 'c.csv');
    const errors = join(dir, 'c.errors.ndjson');
    const lines = Array.from({ length: 1000 }, (_, i) => goodLine(i));

    lines[9] = '9,s,d,,low,new,2024-01-01T00:00:00Z,'; // line 11: empty email
    lines[499] = '499,s,d,a@b.co,asap,new,2024-01-01T00:00:00Z,'; // line 501: unknown priority
    lines[999] = '999,s,d,a@b.co,low,new,yesterday,'; // line 1001: broken date
    writeFileSync(file, HEADER + lines.join('\n') + '\n');

    const inserted: string[] = [];
    const store: TicketStore = {
      async insertBatch(_id, rows) {
        inserted.push(...rows.map((r) => r.external_id));
      },
    };
    const result = await runImport(file, 'imp', store, () => {}, { errorsPath: errors });

    expect(inserted).toHaveLength(997);
    expect(inserted).not.toContain('9');
    expect(result).toEqual({ processed: 1000, inserted: 997, rejected: 3 });

    const report = readFileSync(errors, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { line: number; field: string; message: string });

    expect(report.map(({ line, field }) => ({ line, field }))).toEqual([
      { line: 11, field: 'requester_email' },
      { line: 501, field: 'priority' },
      { line: 1001, field: 'created_at' },
    ]);
    expect(report[1]?.message).toMatch(/must be one of/);
  });

  it('fails once the error limit is exceeded', async () => {
    const file = join(dir, 'd.csv');
    const lines = Array.from({ length: 50 }, (_, i) => `${i},,d,a@b.c,low,new,2024-01-01T00:00:00Z,`);

    writeFileSync(file, HEADER + lines.join('\n') + '\n');

    const store: TicketStore = { insertBatch: () => Promise.resolve() };

    await expect(
      runImport(file, 'imp', store, () => {}, { errorsPath: join(dir, 'd.errors.ndjson'), maxErrors: 10 }),
    ).rejects.toThrow(/more than 10 invalid values/);
  });

  it('stops when the signal aborts', async () => {
    const file = join(dir, 'e.csv');
    const abort = new AbortController();
    const lines = Array.from({ length: 5000 }, (_, i) => goodLine(i));

    writeFileSync(file, HEADER + lines.join('\n') + '\n');

    let batches = 0;
    const store: TicketStore = {
      async insertBatch() {
        batches++;
        abort.abort();
      },
    };

    await expect(
      runImport(file, 'imp', store, () => {}, {
        batchSize: 100,
        errorsPath: join(dir, 'e.errors.ndjson'),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(batches).toBe(1);
  });
});
