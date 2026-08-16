// TEST-ONLY instrumentation, never shipped in a real production build
// (03_realtime_infrastructure.md §39: "Do NOT add a permanent
// technical/admin page ... Prefer tests/instrumentation over adding
// permanent product chrome"; mission §35: "Test-only event injection may
// exist behind test-only dependency wiring, but not a publicly shippable
// debug API").
//
// Compiled out entirely of a real production build: `import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE`
// is a build-time constant Vite inlines and dead-code-eliminates when unset
// (the ordinary production build command never sets it - only the
// Playwright E2E build does, apps/web/playwright.config.ts). This component
// takes no input and triggers no action - it is PASSIVE OBSERVATION of the
// real realtime pipeline (transport state, received test events, and a
// realtime-aware polling query against the already-public, harmless
// `/api/version` endpoint) so apps/web/e2e/realtime.spec.ts can assert on
// real, production-code-path behavior without inventing a fake feature
// query (Step 03 owns no real feature yet - `03_realtime_infrastructure.md`
// §SCOPE forbids wiring one prematurely).
import { memo, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RESYNC_REQUIRED_EVENT_TYPE, MULTI_TAB_DEDUP_WINDOW_MS } from "@bunny-command-center/shared";
import {
  useRealtimeChannel,
  useRealtimeStatus,
  useRealtimeAwareQueryOptions,
  claimEventForToast,
} from "./index.js";
import { useRealtimeTestControls } from "./SseProvider.js";

const TEST_EVENT_TYPE = "dashboard.sse_test_probe_changed";
const PROBE_POLL_INTERVAL_MS = 1000;

declare global {
  interface Window {
    __bccE2E?: { forceDisconnect: () => void; forceDisconnectWithSeededCursor: (id: string) => void };
  }
}

export function realtimeTestProbeEnabled(): boolean {
  // Dot notation (not bracket/computed access) is REQUIRED here, not a
  // style preference: Vite only statically replaces `import.meta.env.VITE_*`
  // references written this exact way with the literal build-time value,
  // which is what lets its minifier prove `realtimeTestProbeEnabled()` is
  // always `false` in an ordinary production build and dead-code-eliminate
  // the entire `<RealtimeTestProbe>` subtree, `useRealtimeTestControls`
  // wiring, and this file's own `window.__bccE2E` assignment - verified by
  // grepping the real built bundle (`apps/web/dist/assets/*.js`) for
  // `realtime-test-probe`/`forceDisconnectForTests`/`__bccE2E` and
  // confirming zero matches after an ordinary `npm run build`. A bracket
  // form (`import.meta.env["VITE_..."]`) was tried first and was NOT
  // recognized by Vite's static replacement, leaving the test-only code
  // present (inert, but not actually stripped) in the real bundle - a real
  // finding, not a hypothetical one.
  return import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE === "true";
}

/**
 * CORRECTNESS-REVIEW ROUND 4: isolated on purpose, as its own memoized,
 * ZERO-PROPS component - never merged back into `RealtimeTestProbe` below.
 * That component calls `useRealtimeStatus()`, whose own `useSyncExternalStore`
 * subscription re-renders it on every transport-state change; if this
 * query probe lived in the SAME component (or an un-memoized child of it),
 * a transport change would incidentally re-render it too, and the E2E
 * suite's polling assertions would pass even if `useRealtimeAwareQueryOptions`
 * itself were completely non-reactive (exactly the bug
 * apps/web/src/realtime/__tests__/realtimeAwareQuery.test.tsx caught: the
 * OLD implementation only "worked" in this probe because of that
 * incidental parent re-render). `memo()` with no props means React skips
 * re-rendering this component when its PARENT re-renders for its own
 * reasons - it only re-renders when a hook it calls ITSELF triggers one,
 * which is exactly what proves the polling reactivity comes from
 * `useRealtimeAwareQueryOptions`'s own subscription, not from incidental
 * propagation down the tree.
 */
const FallbackQueryProbe = memo(function FallbackQueryProbe(): React.JSX.Element {
  const pollQuery = useQuery(
    useRealtimeAwareQueryOptions(
      {
        queryKey: ["e2e-realtime-probe-version"],
        queryFn: async () => {
          const res = await fetch("/api/version");
          return (await res.json()) as unknown;
        },
      },
      PROBE_POLL_INTERVAL_MS,
    ),
  );

  // Counts real fetch completions (not renders) - `dataUpdatedAt` changes
  // exactly once per successful fetch, giving a real, monotonic count of how
  // many times the query function actually ran.
  const [pollFetchCount, setPollFetchCount] = useState(0);
  const lastSeenUpdatedAt = useRef(0);
  useEffect(() => {
    if (pollQuery.dataUpdatedAt > 0 && pollQuery.dataUpdatedAt !== lastSeenUpdatedAt.current) {
      lastSeenUpdatedAt.current = pollQuery.dataUpdatedAt;
      setPollFetchCount((n) => n + 1);
    }
  }, [pollQuery.dataUpdatedAt]);

  return (
    <div
      data-testid="realtime-fallback-query-probe"
      data-poll-fetch-count={String(pollFetchCount)}
      data-poll-status={pollQuery.status}
      style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, overflow: "hidden", opacity: 0 }}
    />
  );
});

export function RealtimeTestProbe(): React.JSX.Element | null {
  const status = useRealtimeStatus();
  const { forceDisconnect, forceDisconnectWithSeededCursor } = useRealtimeTestControls();
  const [receivedLabels, setReceivedLabels] = useState<string[]>([]);
  const [resyncCount, setResyncCount] = useState(0);
  const [toastClaims, setToastClaims] = useState<string[]>([]);

  // Exposes the same test-only disconnect seams Playwright drives
  // (apps/web/e2e/realtime.spec.ts) - never assigned in a real production
  // build (this whole component is compiled out there).
  useEffect(() => {
    window.__bccE2E = { forceDisconnect, forceDisconnectWithSeededCursor };
    return () => {
      delete window.__bccE2E;
    };
  }, [forceDisconnect, forceDisconnectWithSeededCursor]);

  useRealtimeChannel<{ label: string }>(TEST_EVENT_TYPE, (data) => {
    setReceivedLabels((current) => [...current, data.label]);
    // Real multi-tab dedup proof (26_REALTIME_SSE_AND_SYNC.md §Multi-tab):
    // the event's own `label` is a stable identifier every tab that
    // receives this SAME broadcast row shares, exactly like a real
    // `notificationId` would be for a real toast-worthy event.
    void claimEventForToast(data.label, MULTI_TAB_DEDUP_WINDOW_MS).then((claimed) => {
      setToastClaims((current) => [...current, `${data.label}:${claimed ? "claimed" : "suppressed"}`]);
    });
  });

  useRealtimeChannel<{ scope: string; reason: string }>(RESYNC_REQUIRED_EVENT_TYPE, () => {
    setResyncCount((n) => n + 1);
  });

  return (
    <>
      <div
        data-testid="realtime-test-probe"
        data-e2e-controls-ready="true"
        data-transport-state={status.state}
        data-polling-active={status.isPollingFallbackActive ? "true" : "false"}
        data-received-labels={receivedLabels.join(",")}
        data-resync-count={String(resyncCount)}
        data-toast-claims={toastClaims.join(",")}
        style={{
          position: "fixed",
          bottom: 0,
          right: 0,
          width: 1,
          height: 1,
          overflow: "hidden",
          opacity: 0,
        }}
      />
      <FallbackQueryProbe />
    </>
  );
}
