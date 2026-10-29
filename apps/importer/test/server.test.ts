import { existsSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TicketStore } from '../src/db.ts';
import { fakeStore } from './fake-store.ts';
import { createImporterServer, type ImporterOptions, parseTokens } from '../src/server.ts';
import { errorsPath, uploadPath } from '../src/upload.ts';

const HEADER = 'external_id,subject,description,requester_email,priority,status,created_at,tags\n';
const good = (i: number) => `${i},s,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n`;
const CSV = { 'content-type': 'text/csv' };
const TOKENS = { acme: 'secret-acme', globex: 'secret-globex' };
const AUTH = { authorization: 'Bearer secret-acme' };
const rawFetch = globalThis.fetch;

// Every request is sent as the `acme` tenant unless it brings its own authorization header.
const fetch = (input: string, init: RequestInit = {}): Promise<Response> =>
  rawFetch(input, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });
const serve = (store: TicketStore, options?: Partial<ImporterOptions>) =>
  createImporterServer(store, { tokens: TOKENS, ...options });

async function withServer(
  store: TicketStore,
  run: (url: string) => Promise<void>,
  options?: Partial<ImporterOptions>,
): Promise<void> {
  const server = serve(store, options);

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
  const server = serve(fakeStore());
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

  it('with a store, imports the rows and reports processed/inserted', async () => {
    const inserted: string[] = [];
    const csv =
      HEADER +
      '1,Γειά,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n2,"a, b",d,a@b.co,low,new,2024-01-01T00:00:00Z,\n';

    await withServer(
      fakeStore((_id, rows) => {
        inserted.push(...rows.map((r) => r.subject));
      }),
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
      fakeStore((_id, rows) => {
        inserted.push(...rows.map((r) => r.external_id));
      }),
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
    await withServer(fakeStore(), async (url) => {
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
      fakeStore(() => {
        started();

        return new Promise(() => {}); // a DB that never answers
      }),
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
      { insertGraceMs: 50 },
    );
  });

  it('DELETE on a finished import returns 409, on an unknown one 404', async () => {
    await withServer(fakeStore(), async (url) => {
      const importId = await upload(url, HEADER + good(1));

      await expect.poll(() => statusOf(url, importId)).toBe('done');
      expect((await fetch(`${url}/imports/${importId}`, { method: 'DELETE' })).status).toBe(409);
      expect((await fetch(`${url}/imports/nope`, { method: 'DELETE' })).status).toBe(404);
    });
  });

  it('a client that drops the connection mid-upload cancels the import and removes the file', async () => {
    await withServer(fakeStore(), async (url) => {
      const importId = await new Promise<string>((resolve, reject) => {
        const req = request(`${url}/imports`, {
          method: 'POST',
          headers: { ...CSV, ...AUTH, 'content-length': '1000000' },
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
    await withServer(fakeStore(), async (url) => {
      const bad = '1,,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n'.repeat(10_001);
      const importId = await upload(url, HEADER + bad);

      await expect.poll(() => statusOf(url, importId)).toBe('failed');

      const state = await (await fetch(`${url}/imports/${importId}`)).json();

      expect(state).toMatchObject({ reason: 'more than 10000 invalid values, import aborted' });
      expect(existsSync(uploadPath(importId))).toBe(false);
    });
  });
});

describe('hardening', () => {
  const badRow = '1,,d,a@b.co,low,new,2024-01-01T00:00:00Z,\n';

  it('rejects requests without a known token, but keeps /health open', async () => {
    await withServer(fakeStore(), async (url) => {
      expect((await rawFetch(`${url}/health`)).status).toBe(200);
      expect((await rawFetch(`${url}/imports/x`)).status).toBe(401);
      expect((await rawFetch(`${url}/imports/x`, { headers: { authorization: 'Bearer nope' } })).status).toBe(
        401,
      );
      expect((await rawFetch(`${url}/imports`, { method: 'POST', headers: CSV, body: HEADER })).status).toBe(
        401,
      );

      const ok = await fetch(`${url}/imports`, { method: 'POST', headers: CSV, body: HEADER });

      expect(ok.status).toBe(202);
    });
  });

  it('keeps imports private to the tenant whose token started them', async () => {
    const globex = { authorization: 'Bearer secret-globex' };

    await withServer(fakeStore(), async (url) => {
      const importId = await upload(url, HEADER);

      await expect.poll(() => statusOf(url, importId)).toBe('done');
      expect((await fetch(`${url}/imports/${importId}`, { headers: globex })).status).toBe(404);
      expect((await fetch(`${url}/imports/${importId}/errors`, { headers: globex })).status).toBe(404);
      expect((await fetch(`${url}/imports/${importId}`, { method: 'DELETE', headers: globex })).status).toBe(
        404,
      );
    });
  });

  it('hands the import to the store with the tenant of the token', async () => {
    const started: string[] = [];
    const store: TicketStore = {
      ...fakeStore(),
      startImport: async (_id, tenant) => void started.push(tenant),
    };

    await withServer(store, async (url) => {
      const res = await rawFetch(`${url}/imports`, {
        method: 'POST',
        headers: { ...CSV, authorization: 'Bearer secret-globex' },
        body: HEADER,
      });

      expect(res.status).toBe(202);
      await expect.poll(() => started).toEqual(['globex']);
    });
  });

  it('refuses to start without tokens, or when two tenants share one', () => {
    expect(() => createImporterServer(fakeStore(), { tokens: {} })).toThrow(/at least one tenant/);
    expect(() => createImporterServer(fakeStore(), { tokens: { a: 'x', b: 'x' } })).toThrow(/share a token/);
  });

  it('parses IMPORTER_TOKENS', () => {
    expect(parseTokens('acme:a, globex:b:c')).toEqual({ acme: 'a', globex: 'b:c' });
    expect(() => parseTokens('acme')).toThrow(/tenant:token/);
    expect(() => parseTokens('acme:a,acme:b')).toThrow(/twice/);
    expect(parseTokens('')).toEqual({});
  });

  it('refuses a declared size over the limit with 413', async () => {
    await withServer(
      fakeStore(),
      async (url) => {
        const res = await fetch(`${url}/imports`, { method: 'POST', headers: CSV, body: HEADER + good(1) });

        expect(res.status).toBe(413);
      },
      { maxUploadBytes: 10 },
    );
  });

  it('fails an upload that outgrows the limit without a Content-Length', async () => {
    await withServer(
      fakeStore(),
      async (url) => {
        const importId = await new Promise<string>((resolve, reject) => {
          const req = request(`${url}/imports`, { method: 'POST', headers: { ...CSV, ...AUTH } }, (res) => {
            let body = '';

            res.on('data', (chunk: Buffer) => (body += chunk));
            res.on('end', () => resolve((JSON.parse(body) as { importId: string }).importId));
          });

          req.on('error', reject);
          req.write(HEADER);
          req.write(good(1).repeat(10));
          setTimeout(() => req.end(), 50);
        });

        await expect.poll(() => statusOf(url, importId)).toBe('failed');
        expect(existsSync(uploadPath(importId))).toBe(false);
      },
      { maxUploadBytes: 100 },
    );
  });

  it('answers 429 when too many imports are running', async () => {
    await withServer(
      fakeStore(() => new Promise(() => {})),
      async (url) => {
        const first = await upload(url, HEADER + good(1));

        await expect.poll(() => statusOf(url, first)).toBe('importing');
        expect((await fetch(`${url}/imports`, { method: 'POST', headers: CSV, body: HEADER })).status).toBe(
          429,
        );
        await fetch(`${url}/imports/${first}`, { method: 'DELETE' });
        expect((await fetch(`${url}/imports`, { method: 'POST', headers: CSV, body: HEADER })).status).toBe(
          202,
        );
      },
      { maxConcurrentImports: 1, insertGraceMs: 50 },
    );
  });

  it('removes the rows of a cancelled import and answers 410 for its report', async () => {
    const deleted: string[] = [];
    const store: TicketStore = {
      ...fakeStore(() => new Promise(() => {})),
      async deleteImport(id) {
        deleted.push(id);
      },
    };

    await withServer(
      store,
      async (url) => {
        const importId = await upload(url, HEADER + good(1));

        await expect.poll(() => statusOf(url, importId)).toBe('importing');
        expect((await fetch(`${url}/imports/${importId}`, { method: 'DELETE' })).status).toBe(200);
        expect(deleted).toEqual([importId]);
        expect((await fetch(`${url}/imports/${importId}/errors`)).status).toBe(410);
      },
      { insertGraceMs: 50 },
    );
  });

  it('deletes the rows of a cancelled import only after its running INSERT has finished', async () => {
    const events: string[] = [];
    const store: TicketStore = {
      ...fakeStore(async () => {
        events.push('insert started');
        await new Promise((resolve) => setTimeout(resolve, 400));
        events.push('insert committed');
      }),
      async deleteImport() {
        events.push('delete');
      },
    };

    await withServer(store, async (url) => {
      const importId = await upload(url, HEADER + good(1));

      await expect.poll(() => events.includes('insert started')).toBe(true);
      expect((await fetch(`${url}/imports/${importId}`, { method: 'DELETE' })).status).toBe(200);
      expect(events).toEqual(['insert started', 'insert committed', 'delete']);
    });
  });

  it('removes the rows of a failed import', async () => {
    const deleted: string[] = [];
    const store: TicketStore = {
      ...fakeStore(),
      async deleteImport(id) {
        deleted.push(id);
      },
    };

    await withServer(store, async (url) => {
      const failed = await upload(url, HEADER + badRow.repeat(10_001));

      await expect.poll(() => statusOf(url, failed)).toBe('failed');
      expect(deleted).toEqual([failed]);
    });
  });

  it('fails an empty upload instead of reporting done', async () => {
    await withServer(fakeStore(), async (url) => {
      const importId = await upload(url, '');

      await expect.poll(() => statusOf(url, importId)).toBe('failed');
      expect(await (await fetch(`${url}/imports/${importId}`)).json()).toMatchObject({
        reason: 'CSV file has no header',
      });
    });
  });

  it('counts rows skipped because their external_id is already stored', async () => {
    const store: TicketStore = {
      ...fakeStore(),
      insertBatch: async (_id, rows) => rows.length - 1,
    };

    await withServer(store, async (url) => {
      const importId = await upload(url, HEADER + good(1) + good(2));

      await expect.poll(() => statusOf(url, importId)).toBe('done');
      expect(await (await fetch(`${url}/imports/${importId}`)).json()).toMatchObject({
        inserted: 1,
        duplicates: 1,
      });
    });
  });

  it('forgets a finished import and its report after the TTL', async () => {
    await withServer(
      fakeStore(),
      async (url) => {
        const importId = await upload(url, HEADER + badRow);

        await expect.poll(() => statusOf(url, importId)).toBe('done');
        await expect.poll(async () => (await fetch(`${url}/imports/${importId}`)).status).toBe(404);
        await expect.poll(() => existsSync(errorsPath(importId))).toBe(false);
      },
      { recordTtlMs: 300 },
    );
  });

  it('shutdown() cancels running imports and removes their files', async () => {
    const server = serve(
      fakeStore(() => new Promise(() => {})),
      { insertGraceMs: 50 },
    );

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const importId = await upload(url, HEADER + good(1));

    await expect.poll(() => statusOf(url, importId)).toBe('importing');
    expect(existsSync(uploadPath(importId))).toBe(true);

    await server.shutdown();

    expect(existsSync(uploadPath(importId))).toBe(false);
    expect(server.listening).toBe(false);
  });
});
