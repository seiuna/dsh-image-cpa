/** Cancellation plumbing shared by every CPA call: one deadline, one semaphore. */

/** A composed signal plus the reason it fired, and the disposer that releases the timer. */
export interface Deadline {
  readonly signal: AbortSignal;
  /** True when the deadline itself fired rather than the caller cancelling. */
  timedOut(): boolean;
  dispose(): void;
}

/**
 * Compose one absolute deadline with the caller's signal. The returned signal
 * aborts on either input, and `timedOut()` distinguishes a timeout from a user
 * cancellation so the tools can report the right reason.
 */
export function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) {
    onParentAbort();
    return { signal: controller.signal, timedOut: () => false, dispose: () => undefined };
  }
  parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** One waiter in a {@link Semaphore} queue. */
interface Waiter {
  grant(): void;
  fail(error: unknown): void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * Counting semaphore with abortable acquisition. A queued acquisition that is
 * cancelled never runs, so cancelled generations cannot consume a slot later.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`semaphore limit must be >= 1, got ${limit}`);
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Acquire one slot; the resolved function releases it and is idempotent. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1;
      return () => this.release();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal?.reason ?? new Error('aborted'));
        },
        grant: () => {
          signal?.removeEventListener('abort', waiter.onAbort);
          resolve(() => this.release());
        },
        fail: (error) => {
          signal?.removeEventListener('abort', waiter.onAbort);
          reject(error);
        },
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.grant();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  /** Reject every queued acquisition; used when the plugin unloads. */
  dispose(reason: unknown = new Error('plugin disposed')): void {
    for (const waiter of this.queue.splice(0)) waiter.fail(reason);
    this.active = 0;
  }
}
