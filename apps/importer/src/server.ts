import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { ensureUploadDir, receiveUpload } from './upload.ts';

type ImportStatus = 'receiving' | 'done' | 'failed';

interface ImportRecord {
  status: ImportStatus;
  bytes: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createImporterServer(): Server {
  ensureUploadDir();

  const imports = new Map<string, ImportRecord>();

  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' });

      return;
    }

    if (req.method === 'POST' && path === '/imports') {
      const type = (req.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();

      if (type !== 'text/csv') {
        sendJson(res, 415, { error: 'unsupported_media_type' });
        req.resume();

        return;
      }

      const id = randomUUID();
      const record: ImportRecord = { status: 'receiving', bytes: 0 };

      imports.set(id, record);

      sendJson(res, 202, { importId: id });
      receiveUpload(req, id, (bytes) => {
        record.bytes = bytes;
      })
        .then(
          () => {
            record.status = 'done';
          },
          () => {
            record.status = 'failed';
          },
        );

      return;
    }

    const match = req.method === 'GET' ? /^\/imports\/([^/]+)$/.exec(path) : null;

    if (match) {
      const record = imports.get(match[1]!);

      if (record) {
        sendJson(res, 200, { importId: match[1], status: record.status, bytes: record.bytes });

        return;
      }
    }

    sendJson(res, 404, { error: 'not_found' });
  });
}
