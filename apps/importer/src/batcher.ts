import { Transform, type TransformCallback } from 'node:stream';

export const BATCH_SIZE = 1000;

// Groups objects into arrays of `size`; the last array may be shorter.
export class Batcher<T> extends Transform {
  private batch: T[] = [];

  private readonly size: number;

  constructor(size = BATCH_SIZE) {
    super({ objectMode: true });
    this.size = size;
  }

  override _transform(item: T, _encoding: BufferEncoding, cb: TransformCallback): void {
    this.batch.push(item);

    if (this.batch.length >= this.size) {
      const full = this.batch;

      this.batch = [];
      cb(null, full);

      return;
    }

    cb();
  }

  override _flush(cb: TransformCallback): void {
    cb(null, this.batch.length > 0 ? this.batch : undefined);
  }
}
