import { Transform, type TransformCallback } from 'node:stream';

export const BATCH_SIZE = 1000;
/** A batch is also cut once its items weigh this much, so rows with long text cannot fill the heap. */
export const BATCH_MAX_WEIGHT = 250_000;

// Groups objects into arrays of `size` or of `maxWeight` in total, whichever comes first; the last array may be shorter.
export class Batcher<T> extends Transform {
  private batch: T[] = [];
  private weight = 0;

  private readonly size: number;
  private readonly weigh: (item: T) => number;
  private readonly maxWeight: number;

  constructor(size = BATCH_SIZE, weigh: (item: T) => number = () => 0, maxWeight = BATCH_MAX_WEIGHT) {
    super({ objectMode: true });
    this.size = size;
    this.weigh = weigh;
    this.maxWeight = maxWeight;
  }

  override _transform(item: T, _encoding: BufferEncoding, cb: TransformCallback): void {
    this.batch.push(item);
    this.weight += this.weigh(item);

    if (this.batch.length >= this.size || this.weight >= this.maxWeight) {
      const full = this.batch;

      this.batch = [];
      this.weight = 0;
      cb(null, full);

      return;
    }

    cb();
  }

  override _flush(cb: TransformCallback): void {
    cb(null, this.batch.length > 0 ? this.batch : undefined);
  }
}
