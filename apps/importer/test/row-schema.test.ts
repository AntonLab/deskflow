import { describe, expect, it } from 'vitest';
import type { TicketRow } from '../src/csv-parser.ts';
import { validateRow } from '../src/row-schema.ts';

const valid: TicketRow = {
  external_id: '1',
  subject: 'Printer is on fire',
  description: '',
  requester_email: 'a@b.co',
  priority: 'urgent',
  status: 'open',
  created_at: '2024-01-01T00:00:00Z',
  tags: '',
};

describe('validateRow', () => {
  it('accepts a valid row, with an empty description and tags', () => {
    expect(validateRow(2, valid)).toEqual({ row: valid });
  });

  it('accepts an ISO date with an offset', () => {
    expect(validateRow(2, { ...valid, created_at: '2024-01-01T10:00:00+02:00' })).toHaveProperty('row');
  });

  it('trims values', () => {
    expect(validateRow(2, { ...valid, subject: '  hi  ' })).toMatchObject({ row: { subject: 'hi' } });
  });

  it.each([
    ['external_id', ''],
    ['subject', '   '],
    ['requester_email', ''],
    ['requester_email', 'not-an-email'],
    ['priority', 'asap'],
    ['status', 'done'],
    ['created_at', '2024-13-45'],
    ['created_at', '01/02/2024'],
  ])('rejects %s = %j', (field, value) => {
    const result = validateRow(7, { ...valid, [field]: value });

    expect(result).toEqual({ errors: [{ line: 7, field, message: expect.any(String) }] });
  });

  it('rejects a NUL character, which Postgres text cannot hold', () => {
    expect(validateRow(2, { ...valid, subject: 'a\0b' })).toEqual({
      errors: [{ line: 2, field: 'subject', message: 'contains a NUL character' }],
    });
    expect(validateRow(2, { ...valid, tags: 'x\0' })).toEqual({
      errors: [{ line: 2, field: 'tags', message: 'contains a NUL character' }],
    });
  });

  it('reports every bad field of one row', () => {
    const result = validateRow(3, { ...valid, requester_email: '', priority: 'x' });

    expect('errors' in result && result.errors.map((e) => e.field)).toEqual(['requester_email', 'priority']);
  });
});
