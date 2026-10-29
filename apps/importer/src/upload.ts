import { createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const UPLOAD_DIR = join(tmpdir(), 'deskflow-imports');

export function uploadPath(id: string): string {
  return join(UPLOAD_DIR, `${id}.csv`);
}

export function errorsPath(id: string): string {
  return join(UPLOAD_DIR, `${id}.errors.ndjson`);
}

// Create folder if not exist
export function ensureUploadDir(): void {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Streams the body to disk. Resolves with the total byte count, rejects if the stream fails or `signal` aborts.
export async function receiveUpload(
  req: AsyncIterable<Buffer>,
  id: string,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;

  await pipeline(
    req,
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        total += chunk.length;
        onProgress(total);
        yield chunk;
      }
    },
    createWriteStream(uploadPath(id)),
    { signal },
  );

  return total;
}
