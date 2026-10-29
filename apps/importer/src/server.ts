import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import type { TicketStore } from './db.ts';
import { runImport } from './import-job.ts';
import { errorsPath, ensureUploadDir, receiveUpload, removeStaleFiles, uploadPath } from './upload.ts';

type ImportStatus = 'receiving' | 'importing' | 'done' | 'failed' | 'cancelled';

interface ImportRecord {
  status: ImportStatus;
  bytes: number;
  processed: number;
  inserted: number;
  rejected: number;
  duplicates: number;
  /** Why the import is `failed`. */
  reason?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Windows may still hold a just-destroyed stream's handle for a moment, hence the retries.
// A file that still cannot be removed is logged: it must not crash the process.
function removeFiles(...paths: string[]): Promise<void> {
  return Promise.all(paths.map((path) => rm(path, { force: true, maxRetries: 5, retryDelay: 50 }))).then(
    () => undefined,
    (err: unknown) => console.error('could not remove import files', err),
  );
}

function sameToken(given: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(given), digest(expected));
}

// Parses `tenant:token,tenant:token` (the IMPORTER_TOKENS format) into a tenant → token map.
export function parseTokens(spec: string): Record<string, string> {
  const tokens: Record<string, string> = {};

  for (const entry of spec.split(',').filter((part) => part.trim() !== '')) {
    const colon = entry.indexOf(':');
    const tenant = entry.slice(0, colon).trim();
    const token = entry.slice(colon + 1).trim();

    // The message never echoes the entry: it may hold a secret.
    if (colon < 0 || !tenant || !token) throw new Error('bad IMPORTER_TOKENS entry, expected tenant:token');

    if (tenant in tokens) throw new Error(`tenant "${tenant}" is listed twice`);

    tokens[tenant] = token;
  }

  return tokens;
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

export interface ImporterOptions {
  /** Tenant → bearer token. Every route except `/health` needs one of them; the token picks the tenant. */
  tokens: Record<string, string>;
  /** Larger uploads are refused (413) or fail. Default 2 GiB. */
  maxUploadBytes?: number;
  /** More running imports are refused with 429. Default 3. */
  maxConcurrentImports?: number;
  /** How long a finished import stays queryable and keeps its error report. Default 1 hour. */
  recordTtlMs?: number;
  /** How long a cancelled import waits for its running INSERT before its rows are deleted. Default 30 s. */
  insertGraceMs?: number;
}

export interface ImporterServer extends Server {
  /** Aborts running imports, waits for their cleanup, then closes the server. */
  shutdown(): Promise<void>;
}

const STALE_FILE_MS = 24 * 60 * 60 * 1000;

export function createImporterServer(store: TicketStore, options: ImporterOptions): ImporterServer {
  const {
    tokens,
    maxUploadBytes = 2 * 1024 ** 3,
    maxConcurrentImports = 3,
    recordTtlMs = 60 * 60 * 1000,
    insertGraceMs = 30_000,
  } = options;

  const tenantTokens = Object.entries(tokens);

  if (tenantTokens.length === 0 || tenantTokens.some(([tenant, token]) => !tenant || !token)) {
    throw new Error('tokens must list at least one tenant with a non-empty token');
  }

  if (new Set(tenantTokens.map(([, token]) => token)).size !== tenantTokens.length) {
    throw new Error('two tenants share a token');
  }

  ensureUploadDir();
  removeStaleFiles(STALE_FILE_MS).catch((err: unknown) => console.error('could not remove stale files', err));

  const imports = new Map<string, ImportRecord>();
  /** The tenant that started each import; other tenants get 404 for it. */
  const owners = new Map<string, string>();
  const running = new Map<string, { abort: AbortController; job: Promise<void> }>();
  const expiry = new Set<NodeJS.Timeout>();

  // A cancelled or failed import must not leave half of its rows behind. An INSERT still running when the
  // import stopped would commit after the DELETE, so the DELETE waits for it (a DB that never answers is cut off).
  async function discardRows(id: string, record: ImportRecord, lastInsert: Promise<unknown>): Promise<void> {
    try {
      const grace = new Promise((resolve) => setTimeout(resolve, insertGraceMs).unref());

      await Promise.race([lastInsert.catch(() => {}), grace]);
      await store.deleteImport(id);
      record.inserted = 0;
    } catch (err) {
      console.error(`import ${id}: could not remove its rows`, err);
    }
  }

  function expireLater(id: string): void {
    const timer = setTimeout(() => {
      expiry.delete(timer);
      imports.delete(id);
      owners.delete(id);
      void removeFiles(errorsPath(id));
    }, recordTtlMs).unref();

    expiry.add(timer);
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' });

      return;
    }

    const given = req.headers.authorization?.replace(/^Bearer /i, '');
    const tenant =
      given === undefined ? undefined : tenantTokens.find(([, token]) => sameToken(given, token))?.[0];

    if (tenant === undefined) {
      sendJson(res, 401, { error: 'unauthorized' });
      req.resume();

      return;
    }

    if (req.method === 'POST' && path === '/imports') {
      const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();

      if (type !== 'text/csv') {
        sendJson(res, 415, { error: 'unsupported_media_type' });
        req.resume();

        return;
      }

      if (Number(req.headers['content-length'] ?? 0) > maxUploadBytes) {
        sendJson(res, 413, { error: 'payload_too_large' });
        req.resume();

        return;
      }

      if (running.size >= maxConcurrentImports) {
        sendJson(res, 429, { error: 'too_many_imports' });
        req.resume();

        return;
      }

      const id = randomUUID();
      const record: ImportRecord = {
        status: 'receiving',
        bytes: 0,
        processed: 0,
        inserted: 0,
        rejected: 0,
        duplicates: 0,
      };
      const abort = new AbortController();
      let lastInsert: Promise<unknown> = Promise.resolve();
      const importStore: TicketStore = {
        ...store,
        insertBatch: (importId, rows) => (lastInsert = store.insertBatch(importId, rows)),
      };

      imports.set(id, record);
      owners.set(id, tenant);

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
        maxUploadBytes,
      )
        .then(async () => {
          record.status = 'importing';
          await store.startImport(id, tenant);

          await runImport(
            uploadPath(id),
            id,
            importStore,
            ({ processed, inserted, rejected, duplicates }) => {
              record.processed = processed;
              record.inserted = inserted;
              record.rejected = rejected;
              record.duplicates = duplicates;
            },
            { signal: abort.signal, errorsPath: errorsPath(id) },
          );
          // The rows are final now; a crash from here on must not make the next start delete them.
          await store.endImport(id);
          await removeFiles(uploadPath(id));

          record.status = 'done';
        })
        .catch(async (err: unknown) => {
          if (abort.signal.aborted) {
            record.status = 'cancelled';
            await removeFiles(uploadPath(id), errorsPath(id));
            await discardRows(id, record, lastInsert);

            return;
          }

          console.error(`import ${id} failed`, err);

          record.status = 'failed';
          record.reason = err instanceof Error ? err.message : String(err);
          // The report stays: it explains a failure caused by too many invalid rows.
          await removeFiles(uploadPath(id));
          await discardRows(id, record, lastInsert);
        })
        .finally(async () => {
          // The mark stays when this fails (or the process dies): the next start deletes the rows.
          await store
            .endImport(id)
            .catch((err: unknown) => console.error(`import ${id}: could not end it`, err));

          req.socket?.off('close', onSocketClose);
          running.delete(id);
          expireLater(id);
        });

      running.set(id, { abort, job });

      return;
    }

    const match = /^\/imports\/([^/]+)(\/errors)?$/.exec(path);
    const id = match?.[1];
    const record = id !== undefined && owners.get(id) === tenant ? imports.get(id) : undefined;

    if (id !== undefined && record) {
      if (req.method === 'GET' && !match?.[2]) {
        sendJson(res, 200, { importId: id, ...record });

        return;
      }

      if (req.method === 'GET') {
        if (record.status === 'cancelled') {
          sendJson(res, 410, { error: 'cancelled' });

          return;
        }

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

  async function shutdown(): Promise<void> {
    const active = [...running.values()];

    for (const { abort } of active) abort.abort();

    await Promise.allSettled(active.map(({ job }) => job));

    for (const timer of expiry) clearTimeout(timer);

    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return Object.assign(server, { shutdown });
}
