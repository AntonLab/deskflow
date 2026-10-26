import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createImporterServer } from './server.ts';

const port = Number(process.env.IMPORTER_PORT ?? 4010);
const server = createImporterServer();

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
