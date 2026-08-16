// jsdom has no built-in `EventSource` implementation. This inert stub exists
// ONLY so component-level tests that mount the full provider tree (App.test.tsx,
// AppShell.test.tsx, etc. - tests that are NOT specifically about realtime
// behavior) don't crash when `<SseProvider>` constructs its connection
// manager. It never actually "connects" (stays in CONNECTING forever, never
// fires onopen/onerror/events) - it is deliberately NOT a substitute for the
// real transport-state-machine proof (apps/web/src/realtime/__tests__/sseConnectionManager.test.ts,
// which injects its own purpose-built FakeEventSource) or the real-browser
// proof (apps/web/e2e/realtime.spec.ts).
export class InertEventSourceStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = InertEventSourceStub.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(public url: string) {}

  addEventListener(): void {
    /* no-op - this stub never emits anything */
  }

  close(): void {
    this.readyState = InertEventSourceStub.CLOSED;
  }
}

export function installInertEventSourceStub(): void {
  (window as unknown as { EventSource: unknown }).EventSource = InertEventSourceStub;
}
