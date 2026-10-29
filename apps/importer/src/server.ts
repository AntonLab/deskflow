import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import type { TicketStore } from './db.ts';
import { runImport } from './import-job.ts';
import { errorsPath, ensureUploadDir, receiveUpload, uploadPath } from './upload.ts';

type ImportStatus = 'receiving' | 'importing' | 'done' | 'failed' | 'cancelled';

interface ImportRecord {
  status: ImportStatus;
  bytes: number;
  processed: number;
  inserted: number;
  rejected: number;
  /** Why the import is `failed`. */
  reason?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Windows may still hold a just-destroyed stream's handle for a moment, hence the retries.
function removeFiles(...paths: string[]): Promise<unknown> {
  return Promise.all(paths.map((path) => rm(path, { force: true, maxRetries: 5, retryDelay: 50 })));
}

// Serves the NDJSON report; no file means no invalid rows (yet).
function sendErrors(res: ServerResponse, id: string): void {
  const file = createReadStream(errorsPath(id));

  file.once('error', () => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end();
  });
  file.once('open', () => {
    file.removeAllListeners('error');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    pipeline(file, res, () => {});
  });
}

// Without a store the server only saves uploads to disk and skips the DB import.
export function createImporterServer(store?: TicketStore): Server {
  ensureUploadDir();

  const imports = new Map<string, ImportRecord>();
  const running = new Map<string, { abort: AbortController; job: Promise<void> }>();

  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' });

      return;
    }

    if (req.method === 'POST' && path === '/imports') {
      const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();

      if (type !== 'text/csv') {
        sendJson(res, 415, { error: 'unsupported_media_type' });
        req.resume();

        return;
      }

      const id = randomUUID();
      const record: ImportRecord = { status: 'receiving', bytes: 0, processed: 0, inserted: 0, rejected: 0 };
      const abort = new AbortController();

      imports.set(id, record);

      // A client that hangs up before the body is complete cancels the import. After that the 202 is all it waits for.
      // The socket is watched because Node stops reporting an aborted request once its response has been sent.
      const onSocketClose = (): void => {
        if (!req.complete) abort.abort();
      };

      req.socket.once('close', onSocketClose);

      sendJson(res, 202, { importId: id });

      const job = receiveUpload(
        req,
        id,
        (bytes) => {
          record.bytes = bytes;
        },
        abort.signal,
      )
        .then(async () => {
          if (store) {
            record.status = 'importing';

            await runImport(
              uploadPath(id),
              id,
              store,
              ({ processed, inserted, rejected }) => {
                record.processed = processed;
                record.inserted = inserted;
                record.rejected = rejected;
              },
              { signal: abort.signal, errorsPath: errorsPath(id) },
            );
            await removeFiles(uploadPath(id));
          }

          record.status = 'done';
        })
        .catch(async (err: unknown) => {
          if (abort.signal.aborted) {
            record.status = 'cancelled';
            await removeFiles(uploadPath(id), errorsPath(id));

            return;
          }

          console.error(`import ${id} failed`, err);

          record.status = 'failed';
          record.reason = err instanceof Error ? err.message : String(err);
          // The report stays: it explains a failure caused by too many invalid rows.
          await removeFiles(uploadPath(id));
        })
        .finally(() => {
          req.socket?.off('close', onSocketClose);
          running.delete(id);
        });

      running.set(id, { abort, job });

      return;
    }

    const match = /^\/imports\/([^/]+)(\/errors)?$/.exec(path);
    const id = match?.[1];
    const record = id === undefined ? undefined : imports.get(id);

    if (id !== undefined && record) {
      if (req.method === 'GET' && !match?.[2]) {
        sendJson(res, 200, { importId: id, ...record });

        return;
      }

      if (req.method === 'GET') {
        sendErrors(res, id);

        return;
      }

      if (req.method === 'DELETE' && !match?.[2]) {
        const active = running.get(id);

        if (!active) {
          sendJson(res, 409, { error: 'not_running', status: record.status });

          return;
        }

        active.abort.abort();
        void active.job.then(() => {
          // The import may have finished before the abort took effect.
          sendJson(res, record.status === 'cancelled' ? 200 : 409, { importId: id, ...record });
        });

        return;
      }
    }

    sendJson(res, 404, { error: 'not_found' });
  });
}
