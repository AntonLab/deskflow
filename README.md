# DeskFlow

Multi-tenant helpdesk with live chat. Demo/capstone project for a Middle Fullstack learning plan.

## Idea

Companies (tenants) receive support requests as tickets. Agents handle tickets in real time, customers chat with agents live, and existing tickets can be bulk-imported from CSV.

## Planned features

- Multi-tenancy: each company sees only its own data
- Tickets with a status flow: `new` → `open` → `pending` → `resolved` → `closed`
- Live chat between customer and agent
- Bulk CSV import of tickets (streaming upload)
- Background processing via a message queue

## Current state

- `apps/importer` — HTTP service for CSV uploads and import into Postgres (`POST /imports`, `GET /imports/:id`, `GET /health`)
- `packages/contracts` — shared types (ticket statuses)
- `scripts/gen-csv.ts` — generates test CSV files

## CSV import

`POST /imports` (`content-type: text/csv`) saves the upload to disk, then streams it into the `imported_tickets` table:
`file → LineSplitter → CsvParser → Batcher (1000 rows) → DB writer (multi-row INSERT)`.
The writer acknowledges a batch only after the INSERT finishes, so a slow DB slows file reading (backpressure).

Expected header: `external_id,subject,description,requester_email,priority,status,created_at,tags`.
`GET /imports/:id` returns `status` (`receiving` → `importing` → `done` | `failed`), `bytes`, `processed`, `inserted`.
Values are stored as text; validation is DF-003.

Try it: `node scripts/gen-csv.ts 10000000`, then `curl -H "content-type: text/csv" --data-binary @%TMP%/tickets.csv localhost:4010/imports`.
Set `IMPORTER_METRICS=1` to log RSS every second.

Performance: 10M rows, 1.5 GB file, real Postgres 17 in Docker, upload and import through the HTTP API, Windows 11, Node 24.

| Node flags                                        | Peak RSS | Import time |
| ------------------------------------------------- | -------- | ----------- |
| default                                           | ~320 MB  | ~140 s      |
| `--max-semi-space-size=2 --max-old-space-size=80` | 143 MB   | 171 s       |

Memory does not grow with file size, but V8 collects lazily, so the heap is capped in the `dev`/`start` scripts.
The 2 GB acceptance run has not been done; 1.5 GB is the largest file measured.

## Stack

- TypeScript, Node.js >= 22.12
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
