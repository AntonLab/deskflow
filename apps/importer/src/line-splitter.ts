import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';

// Bytes in, one string per line out. StringDecoder keeps a UTF-8 sequence split across chunks intact.
export class LineSplitter extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private rest = '';
  private first = true;

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback): void {
    this.rest += this.decoder.write(chunk);
    this.emitLines();
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.rest += this.decoder.end();
    this.emitLines();

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
    let end = this.rest.indexOf('\n', start);

    while (end !== -1) {
      const stop = end > start && this.rest.charCodeAt(end - 1) === 13 ? end - 1 : end;

      this.push(this.rest.slice(start, stop));
      start = end + 1;
      end = this.rest.indexOf('\n', start);
    }

    this.rest = this.rest.slice(start);
  }
}
