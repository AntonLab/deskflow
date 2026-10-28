import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImporterServer } from '../src/server.ts';

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
      });
  });

  it('with a store, imports the rows and reports processed/inserted', async () => {
    const inserted: string[] = [];
    const withStore = createImporterServer({
      async insertBatch(_id, rows) {
        inserted.push(...rows.map((r) => r.subject));
      },
    });

    await new Promise<void>((resolve) => withStore.listen(0, resolve));

    const url = `http://127.0.0.1:${(withStore.address() as AddressInfo).port}`;
    const csv =
      'external_id,subject,description,requester_email,priority,status,created_at,tags\n' +
      '1,Γειά,d,a@b.c,low,new,t,\n2,"a, b",d,a@b.c,low,new,t,\n';
    const res = await fetch(`${url}/imports`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csv,
    });
    const { importId } = (await res.json()) as { importId: string };

    await expect
      .poll(
        async () => ((await (await fetch(`${url}/imports/${importId}`)).json()) as { status: string }).status,
      )
      .toBe('done');

    const state = await (await fetch(`${url}/imports/${importId}`)).json();

    expect(state).toMatchObject({ processed: 2, inserted: 2 });
    expect(inserted).toEqual(['Γειά', 'a, b']);
    await new Promise<void>((resolve) => withStore.close(() => resolve()));
  });

  it('GET /imports/:id with unknown id returns 404', async () => {
    const res = await fetch(`${base}/imports/nope`);

    expect(res.status).toBe(404);
  });
});
