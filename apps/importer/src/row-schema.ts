import { TICKET_STATUSES } from '@deskflow/contracts';
import { z } from 'zod';
import type { TicketRow } from './csv-parser.ts';

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export interface RowError {
  line: number;
  field: string;
  message: string;
}

// Postgres text cannot hold NUL, so one such character would fail a whole batch.
const noNul = (value: string): boolean => !value.includes('\0');
const NUL_MESSAGE = 'contains a NUL character';

const text = z.string().refine(noNul, NUL_MESSAGE);
const required = (message: string) =>
  z.string({ error: message }).refine(noNul, NUL_MESSAGE).trim().min(1, message);

// Tags and description may be empty; everything else is required.
const rowSchema = z.object({
  external_id: required('is required'),
  subject: required('is required'),
  description: text,
  requester_email: required('is required').pipe(z.email('is not a valid email')),
  priority: required('is required').pipe(
    z.enum(TICKET_PRIORITIES, { error: `must be one of: ${TICKET_PRIORITIES.join(', ')}` }),
  ),
  status: required('is required').pipe(
    z.enum(TICKET_STATUSES, { error: `must be one of: ${TICKET_STATUSES.join(', ')}` }),
  ),
  created_at: required('is required').pipe(
    z.iso.datetime({ offset: true, error: 'is not an ISO 8601 date, e.g. 2024-01-01T00:00:00Z' }),
  ),
  tags: text,
});

// Valid rows come back trimmed; invalid ones yield one entry per bad field.
export function validateRow(line: number, row: TicketRow): { row: TicketRow } | { errors: RowError[] } {
  const result = rowSchema.safeParse(row);

  if (result.success) return { row: result.data };

  const errors = result.error.issues.map((issue) => ({
    line,
    field: String(issue.path[0] ?? ''),
    message: issue.message,
  }));

  return { errors };
}
