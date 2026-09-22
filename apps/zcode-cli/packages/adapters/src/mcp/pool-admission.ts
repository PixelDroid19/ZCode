const MAX_CONCURRENT_MCP_CONNECTIONS = 8;

type Permit = () => void;
interface WaitingConnection {
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (release: Permit) => void;
  reject: (error: unknown) => void;
}

/** One owner per pool; a permit covers the real handshake, not its caller's wait budget. */
export class McpConnectionAdmission {
  private active = 0;
  private closed = false;
  private readonly queue: WaitingConnection[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  acquire(signal: AbortSignal): Promise<Permit> {
    if (this.closed) return Promise.reject(new Error("MCP connection admission is closed"));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiting: WaitingConnection = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiting);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiting.onAbort, { once: true });
      this.queue.push(waiting);
      this.admit();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    for (const waiting of this.queue.splice(0)) {
      waiting.signal.removeEventListener("abort", waiting.onAbort);
      waiting.reject(new Error("MCP connection admission is closed"));
    }
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private admit(): void {
    while (!this.closed && this.active < MAX_CONCURRENT_MCP_CONNECTIONS && this.queue.length) {
      const waiting = this.queue.shift()!;
      waiting.signal.removeEventListener("abort", waiting.onAbort);
      this.active++;
      let released = false;
      waiting.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.admit();
        if (this.active === 0) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
      });
    }
  }
}
