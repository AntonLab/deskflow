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

- `apps/importer` — HTTP service for CSV uploads (`POST /imports`, `GET /health`)
- `packages/contracts` — shared types (ticket statuses)
- `scripts/gen-csv.ts` — generates test CSV files

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
