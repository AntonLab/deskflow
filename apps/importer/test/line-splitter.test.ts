import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../src/line-splitter.ts';

async function split(chunks: Buffer[]): Promise<string[]> {
  const lines: string[] = [];

  for await (const line of Readable.from(chunks).pipe(new LineSplitter())) lines.push(line as string);

  return lines;
}

describe('LineSplitter', () => {
  it('joins a line split between chunks', async () => {
    expect(await split([Buffer.from('ab'), Buffer.from('c\nde'), Buffer.from('f\n')])).toEqual([
      'abc',
      'def',
    ]);
  });

  it('keeps multibyte text intact when a UTF-8 sequence is split between chunks', async () => {
    const bytes = Buffer.from('Γειά,κόσμε\nΑίτημα №1\n');

    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await split([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(['Γειά,κόσμε', 'Αίτημα №1']);
    }
  });

  it('emits the last line without a trailing newline', async () => {
    expect(await split([Buffer.from('a\nb')])).toEqual(['a', 'b']);
  });

  it('strips CRLF, including a CR/LF pair split between chunks', async () => {
    expect(await split([Buffer.from('a\r'), Buffer.from('\nb\r\n')])).toEqual(['a', 'b']);
  });

  it('strips a leading BOM', async () => {
    expect(await split([Buffer.from('﻿a\nb\n')])).toEqual(['a', 'b']);
  });

  it('keeps empty lines', async () => {
    expect(await split([Buffer.from('a\n\nb\n')])).toEqual(['a', '', 'b']);
  });
});
