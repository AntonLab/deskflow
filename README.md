# DeskFlow

Multi-tenant helpdesk with live chat: companies receive support requests as tickets,
agents handle them in real time, and existing tickets can be bulk-imported from CSV.

Work in progress.

## Planned features

- Multi-tenancy: each company sees only its own data
- Tickets with a status flow: `new` → `open` → `pending` → `resolved` → `closed`
- Live chat between customer and agent
- Bulk CSV import of tickets (streaming upload)
- Background processing via a message queue

## Current state

- `apps/importer` — HTTP service for CSV uploads and import into Postgres (`POST /imports`, `GET /imports/:id`, `GET /imports/:id/errors`, `DELETE /imports/:id`, `GET /health`)
- `packages/contracts` — shared types (ticket statuses)
- `scripts/gen-csv.ts` — generates test CSV files

## CSV import

`POST /imports` (`content-type: text/csv`) saves the upload to disk, then streams it into the `imported_tickets` table:
`file → LineSplitter → CsvParser → RowValidator → Batcher (1000 rows or ~250k characters) → DB writer (multi-row INSERT)`.
The writer acknowledges a batch only after the INSERT finishes, so a slow DB slows file reading (backpressure).

Expected header: `external_id,subject,description,requester_email,priority,status,created_at,tags`.
`GET /imports/:id` returns `status` (`receiving` → `importing` → `done` | `failed` | `cancelled`), `bytes`, `processed`, `inserted`, `rejected`, `duplicates` (rows skipped because their `external_id` is already stored; `external_id` is unique) and, for `failed`, a `reason`.
Values are stored as text.

Validation (zod, `src/row-schema.ts`): `external_id`, `subject`, `requester_email` (valid email), `priority` (`low|normal|high|urgent`), `status` (see `packages/contracts`) and `created_at` (ISO 8601) are required; `description` and `tags` may be empty.
An invalid row is not written to the DB. Each bad field becomes one `{ line, field, message }` entry (`line` is the 1-based file line, header = 1) in an NDJSON file served by `GET /imports/:id/errors`.
More than 10 000 entries make the import `failed` with a `reason`; the report is kept. A record longer than 1 MiB (for example a quote at the start of a field that never closes; a quote in the middle of a field, like `5" monitor`, is plain text) also makes the import `failed`.

Cancellation: `DELETE /imports/:id` aborts a running import (200 with status `cancelled`, 409 if it is not running). A client that drops the connection before the upload is complete cancels it the same way.
Cancelling or failing removes the uploaded file and the rows the import already inserted; `GET /imports/:id/errors` then answers 410 for a cancelled import. Finished import records and reports are forgotten after 1 hour (404).
A running import is marked in the `running_imports` table. If the process dies mid-import, the next start deletes the rows of every marked import. This assumes a single service instance.

Access and limits: every route except `GET /health` needs `authorization: Bearer <token>`. `IMPORTER_TOKENS=acme:token-a,globex:token-b` lists one token per tenant (the service refuses to start without it). The token picks the tenant: imports and rows belong to it, another tenant gets 404 for them, and `external_id` is unique per tenant, not globally. It listens on `IMPORTER_HOST` (default `127.0.0.1`). Uploads over 2 GiB get 413 and more than 3 running imports get 429. The upload folder is private (mode 0700); on POSIX the service refuses to start if the folder belongs to another user or is open to others. On SIGINT/SIGTERM the service shuts down gracefully and force-exits after 10 s.

Try it: `node scripts/gen-csv.ts 10000000`, then `curl -H "content-type: text/csv" -H "authorization: Bearer token-a" --data-binary @%TMP%/tickets.csv localhost:4010/imports`.
Set `IMPORTER_METRICS=1` to log RSS every second.

Performance: 10M rows, 1.5 GB file, real Postgres 17 in Docker, upload and import through the HTTP API, Windows 11, Node 24.

| Node flags                                        | Peak RSS | Import time |
| ------------------------------------------------- | -------- | ----------- |
| default                                           | ~320 MB  | ~140 s      |
| `--max-semi-space-size=2 --max-old-space-size=80` | 143 MB   | 171 s       |

Memory does not grow with file size, but V8 collects lazily, so the heap is capped in the `dev`/`start` scripts.
The 2 GB acceptance run has not been done; 1.5 GB is the largest file measured.

## Stack

- TypeScript, Node.js >= 22.18
- npm workspaces + Turborepo
- PostgreSQL 17, Redis 7, RabbitMQ (via Docker Compose)
- Vitest, ESLint, Prettier

## Quick start

```bash
cp .env.example .env
npm install
npm run infra:up   # postgres, redis, rabbitmq
npm run dev
```

Other scripts: `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`.
