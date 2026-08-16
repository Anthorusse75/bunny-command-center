// Multi-tab toast dedup (26_REALTIME_SSE_AND_SYNC.md §Multi-tab: "the first
// tab to see a given event ID within a 500ms window shows the toast, others
// suppress it - a UX polish, not a correctness requirement"). Deliberately a
// DETERMINISTIC tie-break rather than a timing race: every tab that observes
// the same `eventId` within the window announces its own random tab id over
// `BroadcastChannel`; after the window elapses, whichever tab has the
// lexicographically smallest announced id "wins" and shows the toast. This
// avoids both double-toasts (two tabs racing to be "first") and starvation
// (every tab backing off because it saw someone else's announcement) that a
// naive "whoever announces first wins" protocol is prone to under real
// browser event-loop jitter.
const CHANNEL_NAME = "bcc-realtime-toast-dedup";

/**
 * Real-browser E2E testing (apps/web/e2e/realtime.spec.ts) surfaced a real
 * protocol robustness gap: each tab's claim window starts from ITS OWN local
 * receive time, not a shared clock, so under real (if usually small)
 * delivery skew between tabs (independent EventSource connections, real
 * network jitter, real browser scheduling) the FIRST tab's window can close
 * before a SLOWER tab's announcement ever arrives - each side then computes
 * a winner from a different, incomplete view of who's participating, which
 * can (rarely, but really) let two tabs both decide they're the winner. A
 * fixed safety margin added to the internal LISTEN duration (not to the
 * documented 500ms user-facing "a toast appears within ~500ms" expectation)
 * meaningfully closes that window at negligible UX cost, without changing
 * the documented algorithm (still a deterministic lexicographic tie-break
 * over whoever announced within the window).
 */
const LISTEN_SAFETY_MARGIN_MS = 300;

interface AnnounceMessage {
  type: "announce";
  eventId: string;
  tabId: string;
}

/**
 * Pure tie-break: does `ownTabId` win among every tab id observed for one
 * event (including itself)? Extracted from the timing/`BroadcastChannel`
 * plumbing around it so the actual DECISION rule is directly,
 * deterministically unit-testable without depending on real cross-instance
 * message delivery latency.
 */
export function pickDedupWinner(ownTabId: string, seenTabIds: ReadonlySet<string>): boolean {
  const winner = [...seenTabIds].sort()[0];
  return winner === ownTabId;
}

export interface DedupClaimer {
  claimEventForToast(eventId: string, windowMs: number): Promise<boolean>;
  close(): void;
}

/**
 * Creates an independent claimer bound to its own `BroadcastChannel`
 * instance and random tab id. Production code uses the module-level default
 * (`claimEventForToast` below) - one instance per tab, exactly matching a
 * real browser tab's lifetime. Tests use this factory directly to create
 * multiple independent "simulated tabs" within a single process: per the
 * `BroadcastChannel` spec, self-exclusion (a channel never receives its own
 * `postMessage`) is scoped to the OBJECT instance, not the process/window -
 * so two distinct `BroadcastChannel` objects with the same name genuinely
 * see each other's messages even inside the same test process, which is
 * what makes this level of unit testing meaningful at all.
 */
export function createDedupClaimer(): DedupClaimer {
  const tabId =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
  let channel: BroadcastChannel | null = null;
  let unavailable = false;

  function getChannel(): BroadcastChannel | null {
    if (unavailable) return null;
    if (!channel) {
      if (typeof BroadcastChannel === "undefined") {
        unavailable = true;
        return null;
      }
      channel = new BroadcastChannel(CHANNEL_NAME);
    }
    return channel;
  }

  return {
    claimEventForToast(eventId: string, windowMs: number): Promise<boolean> {
      const ch = getChannel();
      if (!ch) {
        // No BroadcastChannel support (very old browser) - fail open, this tab claims it.
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const seenTabIds = new Set<string>([tabId]);
        const onMessage = (event: MessageEvent<AnnounceMessage>): void => {
          const msg = event.data;
          if (msg && msg.type === "announce" && msg.eventId === eventId) {
            seenTabIds.add(msg.tabId);
          }
        };
        ch.addEventListener("message", onMessage);
        ch.postMessage({ type: "announce", eventId, tabId } satisfies AnnounceMessage);

        setTimeout(() => {
          ch.removeEventListener("message", onMessage);
          resolve(pickDedupWinner(tabId, seenTabIds));
        }, windowMs + LISTEN_SAFETY_MARGIN_MS);
      });
    },
    close(): void {
      channel?.close();
      channel = null;
    },
  };
}

const defaultClaimer = createDedupClaimer();

/** Resolves `true` if THIS tab should show the toast for `eventId`, `false` if another tab already claimed it. */
export function claimEventForToast(eventId: string, windowMs: number): Promise<boolean> {
  return defaultClaimer.claimEventForToast(eventId, windowMs);
}
