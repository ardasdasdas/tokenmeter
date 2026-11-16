interface Waiting<I, O> {
  input: I;
  resolve: (value: O | undefined) => void;
  reject: (reason: unknown) => void;
}

/**
 * Runs one job at a time. While a job runs, only the newest pushed input is kept
 * waiting; superseded pushes resolve `undefined` without running.
 */
export class LatestOnly<I, O> {
  private readonly run: (input: I) => Promise<O>;
  private running = false;
  private waiting: Waiting<I, O> | undefined;

  constructor(run: (input: I) => Promise<O>) {
    this.run = run;
  }

  push(input: I): Promise<O | undefined> {
    return new Promise((resolve, reject) => {
      this.waiting?.resolve(undefined);
      this.waiting = { input, resolve, reject };
      if (!this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let job = this.waiting; job; job = this.waiting) {
        this.waiting = undefined;
        try {
          job.resolve(await this.run(job.input));
        } catch (e) {
          job.reject(e);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
