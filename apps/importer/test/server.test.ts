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

  it('неизвестный путь → 404', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('POST /imports с не-CSV → 415 { error }', async () => {
    const res = await fetch(`${base}/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it('POST /imports → 202, затем GET показывает done и счётчик байт', async () => {
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
      .toEqual({ importId, status: 'done', bytes: Buffer.byteLength(body) });
  });

  it('GET /imports/:id неизвестный → 404', async () => {
    const res = await fetch(`${base}/imports/nope`);
    expect(res.status).toBe(404);
  });
});
