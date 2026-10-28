import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import { createPgStore, ensureSchema } from './db.ts';
import { createImporterServer } from './server.ts';

const port = Number(process.env.IMPORTER_PORT ?? 4010);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

await ensureSchema(pool);

const server = createImporterServer(createPgStore(pool));

server.listen(port, () => {
  console.warn(`importer listening on http://localhost:${port}`);
});

if (process.env.IMPORTER_METRICS === '1') {
  const lag = monitorEventLoopDelay({ resolution: 10 });

  lag.enable();

  setInterval(() => {
    const rssMb = (process.memoryUsage.rss() / 1024 / 1024).toFixed(0);
    console.warn(`rss=${rssMb}MB lag_p99=${(lag.percentile(99) / 1e6).toFixed(1)}ms`);
    lag.reset();
  }, 1000).unref();
}
