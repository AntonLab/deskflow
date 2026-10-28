// Usage: node scripts/gen-csv.ts [rows] [out]   (default 10 rows -> %TMP%/tickets.csv). Do not commit the output.
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const rows = Number(process.argv[2] ?? 10_000_000);
const out = process.argv[3] ?? join(tmpdir(), 'tickets.csv');
const stream = createWriteStream(out);

stream.write('external_id,subject,description,requester_email,priority,status,created_at,tags\n');

for (let i = 1; i <= rows; i++) {
  const line = `${i},Ticket subject number ${i},"Description, with comma, for ticket ${i}",user${i}@example.com,normal,open,2024-01-01T00:00:00Z,billing;vip\n`;
  if (!stream.write(line)) await once(stream, 'drain');
}

stream.end();

await once(stream, 'finish');
console.warn(`wrote ${rows} rows to ${out}`);
