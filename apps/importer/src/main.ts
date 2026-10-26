import { createImporterServer } from './server.ts';

const port = Number(process.env.IMPORTER_PORT ?? 4010);
const server = createImporterServer();

server.listen(port, () => {
  console.warn(`importer listening on http://localhost:${port}`);
});
