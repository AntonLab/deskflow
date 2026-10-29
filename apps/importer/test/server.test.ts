import { existsSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TicketStore } from '../src/db.ts';
import { createImporterServer } from '../src/server.ts';
import { errorsPath, uploadPath } from '../src/upload.ts';

const HEADER = 'external_id,subject,description,requester_email,priority,status,created_at,tags\n';
const good = (i: number) => `${i},s,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n`;
const CSV = { 'content-type': 'text/csv' };

async function withServer(store: TicketStore, run: (url: string) => Promise<void>): Promise<void> {
  const server = createImporterServer(store);

  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function upload(url: string, body: string): Promise<string> {
  const res = await fetch(`${url}/imports`, { method: 'POST', headers: CSV, body });

  return ((await res.json()) as { importId: string }).importId;
}

const statusOf = async (url: string, id: string) =>
  ((await (await fetch(`${url}/imports/${id}`)).json()) as { status: string }).status;

describe('importer server', () => {
  const server = createImporterServer();
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('GET /health → 200 ok', async () => {
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('unknown path returns 404', async () => {
    const res = await fetch(`${base}/nope`);

    expect(res.status).toBe(404);
  });

  it('POST /imports with non-CSV returns 415 { error }', async () => {
    const res = await fetch(`${base}/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it('POST /imports returns 202, then GET shows done and byte count', async () => {
    const body = 'id,subject\n1,hello\n';
    const res = await fetch(`${base}/imports`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv; charset=utf-8' },
      body,
    });
    expect(res.status).toBe(202);

    const { importId } = (await res.json()) as { importId: string };
    await expect
      .poll(async () => (await fetch(`${base}/imports/${importId}`)).json())
      .toEqual({
        importId,
        status: 'done',
        bytes: Buffer.byteLength(body),
        processed: 0,
        inserted: 0,
        rejected: 0,
      });
  });

  it('with a store, imports the rows and reports processed/inserted', async () => {
    const inserted: string[] = [];
    const csv =
      HEADER +
      '1,Γειά,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n2,"a, b",d,a@b.co,low,new,2024-01-01T00:00:00Z,\n';

    await withServer(
      {
        async insertBatch(_id, rows) {
          inserted.push(...rows.map((r) => r.subject));
        },
      },
      async (url) => {
        const importId = await upload(url, csv);

        await expect.poll(() => statusOf(url, importId)).toBe('done');

        const state = await (await fetch(`${url}/imports/${importId}`)).json();

        expect(state).toMatchObject({ processed: 2, inserted: 2, rejected: 0 });
        expect(inserted).toEqual(['Γειά', 'a, b']);
      },
    );
  });

  it('GET /imports/:id with unknown id returns 404', async () => {
    const res = await fetch(`${base}/imports/nope`);

    expect(res.status).toBe(404);
  });

  it('GET /imports/:id/errors with unknown id returns 404', async () => {
    const res = await fetch(`${base}/imports/nope/errors`);

    expect(res.status).toBe(404);
  });
});

describe('validation report and cancellation', () => {
  it('serves invalid rows from GET /imports/:id/errors and imports the rest', async () => {
    const inserted: string[] = [];

    await withServer(
      {
        async insertBatch(_id, rows) {
          inserted.push(...rows.map((r) => r.external_id));
        },
      },
      async (url) => {
        const csv =
          HEADER +
          good(1) +
          '2,s,d,,low,new,2024-01-01T00:00:00Z,\n' +
          good(3) +
          '4,s,d,a@b.co,asap,new,x,\n';
        const importId = await upload(url, csv);

        await expect.poll(() => statusOf(url, importId)).toBe('done');

        const state = await (await fetch(`${url}/imports/${importId}`)).json();
        const errors = await fetch(`${url}/imports/${importId}/errors`);
        const entries = (await errors.text())
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { line: number; field: string });

        expect(state).toMatchObject({ processed: 4, inserted: 2, rejected: 2 });
        expect(inserted).toEqual(['1', '3']);
        expect(errors.headers.get('content-type')).toBe('application/x-ndjson');
        expect(entries.map(({ line, field }) => `${line}:${field}`)).toEqual([
          '3:requester_email',
          '5:priority',
          '5:created_at',
        ]);
      },
    );
  });

  it('returns an empty report when every row is valid', async () => {
    await withServer({ insertBatch: () => Promise.resolve() }, async (url) => {
      const importId = await upload(url, HEADER + good(1));

      await expect.poll(() => statusOf(url, importId)).toBe('done');

      const errors = await fetch(`${url}/imports/${importId}/errors`);

      expect(errors.status).toBe(200);
      expect(await errors.text()).toBe('');
    });
  });

  it('DELETE /imports/:id stops a running import within 1 s and removes temp files', async () => {
    let started!: () => void;
    const firstBatch = new Promise<void>((resolve) => (started = resolve));

    await withServer(
      {
        insertBatch: () => {
          started();

          return new Promise(() => {}); // a DB that never answers
        },
      },
      async (url) => {
        const importId = await upload(url, HEADER + good(1));

        await firstBatch;

        const t0 = Date.now();
        const del = await fetch(`${url}/imports/${importId}`, { method: 'DELETE' });

        expect(del.status).toBe(200);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(await statusOf(url, importId)).toBe('cancelled');
        expect(existsSync(uploadPath(importId))).toBe(false);
        expect(existsSync(errorsPath(importId))).toBe(false);
      },
    );
  });

  it('DELETE on a finished import returns 409, on an unknown one 404', async () => {
    await withServer({ insertBatch: () => Promise.resolve() }, async (url) => {
      const importId = await upload(url, HEADER + good(1));

      await expect.poll(() => statusOf(url, importId)).toBe('done');
      expect((await fetch(`${url}/imports/${importId}`, { method: 'DELETE' })).status).toBe(409);
      expect((await fetch(`${url}/imports/nope`, { method: 'DELETE' })).status).toBe(404);
    });
  });

  it('a client that drops the connection mid-upload cancels the import and removes the file', async () => {
    await withServer({ insertBatch: () => Promise.resolve() }, async (url) => {
      const importId = await new Promise<string>((resolve, reject) => {
        const req = request(`${url}/imports`, {
          method: 'POST',
          headers: { ...CSV, 'content-length': '1000000' },
        });

        req.on('response', (res) => {
          let body = '';

          res.on('data', (chunk: Buffer) => (body += chunk));
          res.on('end', () => resolve((JSON.parse(body) as { importId: string }).importId));
        });
        req.on('error', () => {});
        req.write(HEADER + good(1));
        setTimeout(() => req.destroy(), 100);
        setTimeout(() => reject(new Error('no response')), 2000).unref();
      });

      await expect.poll(() => statusOf(url, importId)).toBe('cancelled');
      expect(existsSync(uploadPath(importId))).toBe(false);
    });
  });

  it('fails with a reason when there are more than 10 000 errors', async () => {
    await withServer({ insertBatch: () => Promise.resolve() }, async (url) => {
      const bad = '1,,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n'.repeat(10_001);
      const importId = await upload(url, HEADER + bad);

      await expect.poll(() => statusOf(url, importId)).toBe('failed');

      const state = await (await fetch(`${url}/imports/${importId}`)).json();

      expect(state).toMatchObject({ reason: 'more than 10000 invalid values, import aborted' });
      expect(existsSync(uploadPath(importId))).toBe(false);
    });
  });
});
