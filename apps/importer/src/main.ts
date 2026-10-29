import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import { createPgStore, ensureSchema } from './db.ts';
import { createImporterServer, parseTokens } from './server.ts';

const port = Number(process.env.IMPORTER_PORT ?? 4010);
// Loopback by default; set IMPORTER_HOST=0.0.0.0 (behind a proxy) to accept remote connections.
const host = process.env.IMPORTER_HOST ?? '127.0.0.1';

// IMPORTER_TOKENS="acme:token-a,globex:token-b": each token authenticates one tenant, which owns its imports and rows.
let tokens: Record<string, string> = {};

try {
  tokens = parseTokens(process.env.IMPORTER_TOKENS ?? '');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (Object.keys(tokens).length === 0) {
  console.error('IMPORTER_TOKENS is not set (tenant:token,...); refusing to start an open importer');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// Without a listener an error on an idle connection (for example a database restart) crashes the process.
pool.on('error', (err) => console.error('pg pool error', err));

await ensureSchema(pool);

const store = createPgStore(pool);
// Import state lives in memory, so rows of an import that was running when the process died have no owner.
const discarded = await store.discardInterrupted();

if (discarded > 0) console.warn(`removed leftovers of ${discarded} interrupted import(s)`);

const server = createImporterServer(store, { tokens });

server.listen(port, host, () => {
  console.warn(`importer listening on http://${host}:${port}`);
});

// A database that stops answering must not keep the process alive after SIGTERM.
const SHUTDOWN_LIMIT_MS = 10_000;

const stop = (): void => {
  setTimeout(() => process.exit(1), SHUTDOWN_LIMIT_MS).unref();

  void server
    .shutdown()
    .then(() => pool.end())
    .finally(() => process.exit(0));
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);

if (process.env.IMPORTER_METRICS === '1') {
  const lag = monitorEventLoopDelay({ resolution: 10 });

  lag.enable();

  setInterval(() => {
    const rssMb = (process.memoryUsage.rss() / 1024 / 1024).toFixed(0);
    console.warn(`rss=${rssMb}MB lag_p99=${(lag.percentile(99) / 1e6).toFixed(1)}ms`);
    lag.reset();
  }, 1000).unref();
}
