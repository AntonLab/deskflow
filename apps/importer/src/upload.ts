import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const UPLOAD_DIR = join(tmpdir(), 'deskflow-imports');

export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`upload is larger than ${limit} bytes`);
  }
}

export function uploadPath(id: string): string {
  return join(UPLOAD_DIR, `${id}.csv`);
}

export function errorsPath(id: string): string {
  return join(UPLOAD_DIR, `${id}.errors.ndjson`);
}

// Creates the folder for the owner only. The system temp folder is shared, so a folder that another user
// created first (and could read or change) is refused.
export function ensureUploadDir(): void {
  mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

  const info = statSync(UPLOAD_DIR);

  if (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) {
    throw new Error(`${UPLOAD_DIR} is not private to this user; remove it or fix its owner and mode`);
  }
}

// Import state lives in memory, so files of a process that died are never claimed again. Age keeps live imports safe.
export async function removeStaleFiles(maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;

  for (const name of await readdir(UPLOAD_DIR)) {
    const path = join(UPLOAD_DIR, name);

    // Another import may remove its own file between readdir and stat.
    const age = await stat(path).then(
      (info) => info.mtimeMs,
      () => Infinity,
    );

    if (age < cutoff) await rm(path, { force: true });
  }
}

// Streams the body to disk. Resolves with the total byte count, rejects if the stream fails,
// `signal` aborts or the body is larger than `maxBytes`.
export async function receiveUpload(
  req: AsyncIterable<Buffer>,
  id: string,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
  maxBytes = Infinity,
): Promise<number> {
  let total = 0;

  await pipeline(
    req,
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        total += chunk.length;

        if (total > maxBytes) throw new UploadTooLargeError(maxBytes);

        onProgress(total);
        yield chunk;
      }
    },
    createWriteStream(uploadPath(id)),
    { signal },
  );

  return total;
}
