import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';

/** Longest line or CSV record accepted. A file with no line breaks or a stray quote would otherwise be buffered whole. */
export const MAX_RECORD_CHARS = 1_048_576;

// Bytes in, one string per line out. StringDecoder keeps a UTF-8 sequence split across chunks intact.
export class LineSplitter extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private rest = '';
  /** Start of the part of `rest` not yet searched for a line break. */
  private scanned = 0;
  private first = true;

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback): void {
    this.rest += this.decoder.write(chunk);

    try {
      this.emitLines();
    } catch (err) {
      cb(err as Error);

      return;
    }

    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.rest += this.decoder.end();

    try {
      this.emitLines();
    } catch (err) {
      cb(err as Error);

      return;
    }

    if (this.rest.length > 0) {
      this.push(this.rest.replace(/\r$/, ''));
      this.rest = '';
    }

    cb();
  }

  private emitLines(): void {
    if (this.first && this.rest.length > 0) {
      this.first = false;

      if (this.rest.charCodeAt(0) === 0xfeff) this.rest = this.rest.slice(1);
    }

    let start = 0;
    let end = this.rest.indexOf('\n', this.scanned);

    while (end !== -1) {
      const stop = end > start && this.rest.charCodeAt(end - 1) === 13 ? end - 1 : end;

      this.push(this.rest.slice(start, stop));
      start = end + 1;
      end = this.rest.indexOf('\n', start);
    }

    this.rest = this.rest.slice(start);
    this.scanned = this.rest.length;

    if (this.rest.length > MAX_RECORD_CHARS) {
      throw new Error(`line is longer than ${MAX_RECORD_CHARS} characters`);
    }
  }
}
