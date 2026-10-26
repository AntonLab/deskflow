import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

type ImportStatus = 'receiving' | 'done' | 'failed';

interface ImportRecord {
  status: ImportStatus;
  bytes: number;
}

const UPLOAD_DIR = join(tmpdir(), 'deskflow-imports');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createImporterServer(): Server {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const imports = new Map<string, ImportRecord>();

  async function receive(req: AsyncIterable<Buffer>, id: string, record: ImportRecord) {
    try {
      await pipeline(
        req,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            record.bytes += chunk.length;
            yield chunk;
          }
        },
        createWriteStream(join(UPLOAD_DIR, `${id}.csv`)),
      );
      record.status = 'done';
    } catch {
      record.status = 'failed';
    }
  }

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
      const record: ImportRecord = { status: 'receiving', bytes: 0 };
      imports.set(id, record);
      sendJson(res, 202, { importId: id });
      void receive(req, id, record);
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
