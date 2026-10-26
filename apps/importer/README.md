# @deskflow/importer

Streaming CSV upload service. Today it only receives the file and counts bytes; parsing and DB writes land in DF-002.

## API

| Method | Path           | Description                                                                                        |
| ------ | -------------- | -------------------------------------------------------------------------------------------------- |
| POST   | `/imports`     | Body `text/csv`, streamed to a temp file. `202 { importId }`. Other content types: `415 { error }` |
| GET    | `/imports/:id` | `{ importId, status, bytes }`, status is `receiving` / `done` / `failed`. Unknown id: `404`        |
| GET    | `/health`      | `{ status: 'ok' }`                                                                                 |

Uploads are written to `<os tmpdir>/deskflow-imports/<importId>.csv`. Import state is in memory and is lost on restart.

## Measuring

```sh
IMPORTER_METRICS=1 npm run start -w @deskflow/importer   # logs rss and event loop lag p99 once per second
node scripts/gen-csv.ts 30000000 <path>/tickets.csv      # ~2.7 GB, do not commit
curl -X POST -H 'content-type: text/csv' --data-binary @<path>/tickets.csv http://localhost:4010/imports
npx autocannon -c 50 -d 20 http://localhost:4010/health  # while the upload runs
```

## Numbers

Upload of a 2.7 GB CSV (30M rows) with `autocannon -c 50 -d 20` on `/health` in parallel. Node 24, Windows 11. Peak values over the run.

| Metric                      | Before (DF-001, stream to disk) | After (DF-002) |
| --------------------------- | ------------------------------- | -------------- |
| RSS                         | 89 MB                           |                |
| Event loop lag p99          | 24 ms                           |                |
| `/health` latency p99       | 1 ms (max 24 ms)                |                |
| `/health` throughput, req/s | ~37 000 avg                     |                |
