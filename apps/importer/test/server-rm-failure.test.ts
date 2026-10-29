import type { AddressInfo } from 'node:net';
import type * as FsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { fakeStore } from './fake-store.ts';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  rm: vi.fn(async () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  }),
}));

const { createImporterServer } = await import('../src/server.ts');

describe('file removal failures', () => {
  it('are logged and do not crash the process or break the import record', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createImporterServer(fakeStore(), { tokens: { acme: 't' } });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/imports`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', authorization: 'Bearer t' },
      body: 'wrong,header\n1,2\n',
    });
    const { importId } = (await res.json()) as { importId: string };

    await expect
      .poll(
        async () =>
          (
            (await (
              await fetch(`${url}/imports/${importId}`, { headers: { authorization: 'Bearer t' } })
            ).json()) as { status: string }
          ).status,
      )
      .toBe('failed');
    expect(error).toHaveBeenCalledWith('could not remove import files', expect.any(Error));

    await server.shutdown();
    error.mockRestore();
  });
});
