/**
 * A minimal REAL HTTP SSE client for integration tests - deliberately NOT
 * `EventSource` (Node has no built-in EventSource in this runtime context,
 * and the point of these tests is to prove the real byte-level HTTP
 * streaming contract, not a browser API). Reads response chunks as they
 * arrive over an actual socket and decodes SSE frames incrementally, so a
 * test can assert "an event arrived while the connection is still open" -
 * mission §9: "Tests must observe events arriving while the connection
 * remains open."
 */
import http from "node:http";

export interface ParsedSseFrame {
  event?: string;
  id?: string;
  data?: string;
  retry?: string;
}

function parseFrame(raw: string): ParsedSseFrame {
  const frame: ParsedSseFrame = {};
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) frame.event = line.slice("event: ".length);
    else if (line.startsWith("id: ")) frame.id = line.slice("id: ".length);
    else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
    else if (line.startsWith("retry: ")) frame.retry = line.slice("retry: ".length);
  }
  if (dataLines.length > 0) {
    frame.data = dataLines.join("\n");
  }
  return frame;
}

export class SseTestClient {
  readonly frames: ParsedSseFrame[] = [];
  readonly headers: Promise<http.IncomingHttpHeaders>;
  readonly statusCode: Promise<number | undefined>;
  private req: http.ClientRequest;
  private buffer = "";
  private waiters: { predicate: (f: ParsedSseFrame) => boolean; resolve: (f: ParsedSseFrame) => void }[] = [];
  private closed = false;

  constructor(
    port: number,
    opts: { lastEventId?: string; path?: string; cookies?: Record<string, string> } = {},
  ) {
    let resolveHeaders!: (h: http.IncomingHttpHeaders) => void;
    let resolveStatus!: (s: number | undefined) => void;
    this.headers = new Promise((resolve) => (resolveHeaders = resolve));
    this.statusCode = new Promise((resolve) => (resolveStatus = resolve));

    const headers: Record<string, string> = {};
    if (opts.lastEventId !== undefined) {
      headers["Last-Event-ID"] = opts.lastEventId;
    }
    if (opts.cookies) {
      headers["Cookie"] = Object.entries(opts.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    }

    this.req = http.request(
      { host: "127.0.0.1", port, path: opts.path ?? "/api/stream", method: "GET", headers },
      (res) => {
        resolveHeaders(res.headers);
        resolveStatus(res.statusCode);
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => this.onChunk(chunk));
        res.on("end", () => {
          this.closed = true;
        });
        res.on("close", () => {
          this.closed = true;
        });
      },
    );
    this.req.on("error", () => {
      this.closed = true;
    });
    this.req.end();
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    // SSE frames are separated by a blank line ("\n\n").
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (raw.trim().length === 0) continue;
      const frame = parseFrame(raw);
      this.frames.push(frame);
      const stillWaiting: typeof this.waiters = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(frame)) {
          waiter.resolve(frame);
        } else {
          stillWaiting.push(waiter);
        }
      }
      this.waiters = stillWaiting;
    }
  }

  async waitForFrame(predicate: (f: ParsedSseFrame) => boolean, timeoutMs = 5000): Promise<ParsedSseFrame> {
    const already = this.frames.find(predicate);
    if (already) {
      return already;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolveWrapped);
        reject(
          new Error(
            `waitForFrame timed out after ${timeoutMs}ms. Frames so far: ${JSON.stringify(this.frames)}`,
          ),
        );
      }, timeoutMs);
      const resolveWrapped = (f: ParsedSseFrame): void => {
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push({ predicate, resolve: resolveWrapped });
    });
  }

  /** Simulates a real client/network disconnect (mission §15: "browser/network disconnect"). */
  destroy(): void {
    this.req.destroy();
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
