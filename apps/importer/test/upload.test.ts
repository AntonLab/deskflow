import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureUploadDir, removeStaleFiles, uploadPath } from '../src/upload.ts';

describe.skipIf(process.platform === 'win32')('ensureUploadDir', () => {
  it('keeps the upload folder private to the current user', () => {
    ensureUploadDir();

    const info = statSync(join(tmpdir(), 'deskflow-imports'));

    expect(info.mode & 0o077).toBe(0);
    expect(info.uid).toBe(process.getuid!());
  });
});

describe('removeStaleFiles', () => {
  it('removes files older than the limit and keeps recent ones', async () => {
    ensureUploadDir();

    const old = uploadPath('stale-test-old');
    const recent = uploadPath('stale-test-recent');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);

    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    utimesSync(old, longAgo, longAgo);

    // Only files this test wrote are touched by the 24 h limit; other tests' files are fresh.
    await removeStaleFiles(24 * 3600 * 1000);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});
