// Usage: node scripts/gen-csv.ts [rows] [out]   (default 10M rows -> %TMP%/tickets.csv). Do not commit the output.
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const rows = Number(process.argv[2] ?? 10_000_000);
const out = process.argv[3] ?? join(tmpdir(), 'tickets.csv');
const stream = createWriteStream(out);

stream.write('id,subject,status,requester_email,created_at\n');
for (let i = 1; i <= rows; i++) {
  const line = `${i},Ticket subject number ${i},open,user${i}@example.com,2024-01-01T00:00:00Z\n`;
  if (!stream.write(line)) await once(stream, 'drain');
}
stream.end();
await once(stream, 'finish');
console.warn(`wrote ${rows} rows to ${out}`);
