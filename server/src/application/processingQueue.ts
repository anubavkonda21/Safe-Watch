/**
 * In-process concurrency limiter with a bounded wait queue. Enough for one
 * server; replaced by a real job queue behind the same shape when scaling out.
 */
export class ProcessingQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  get activeCount() { return this.active; }
  get queuedCount() { return this.waiting.length; }

  /** True if a new job could start now or wait without exceeding the queue bound. */
  hasCapacity(): boolean {
    return this.active < this.maxConcurrent || this.waiting.length < this.maxQueued;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over without releasing it
      else this.active -= 1;
    }
  }
}
