/**
 * Correctness-review round 4: proves the fallback-aware query abstraction
 * itself reacts to a transport-state change, WITHOUT relying on any
 * incidental re-render from a sibling/parent hook. The test component here
 * deliberately calls ONLY the fallback-aware query helper - never
 * `useRealtimeStatus()`/`useRealtimeTransportState()` separately, and has no
 * parent whose own transport-state subscription could cause an incidental
 * re-render that masks a non-reactive implementation. This distinction is
 * the whole point: apps/web/src/realtime/RealtimeTestProbe.tsx previously
 * called `useRealtimeStatus()` and the fallback query in the SAME component,
 * so a transport-state change re-rendered the WHOLE component (status hook
 * included) and incidentally re-evaluated `refetchInterval` too - masking
 * the fact that the query helper itself never subscribed to anything.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRealtimeTransportStateForTests, setRealtimeTransportState } from "../realtimeStatusStore.js";
import { useRealtimeAwareQueryOptions } from "../realtimeAwareQuery.js";

const FALLBACK_INTERVAL_MS = 200;

function IsolatedFallbackQueryProbe({ queryFn }: { queryFn: () => Promise<number> }): React.JSX.Element {
  const query = useQuery(
    useRealtimeAwareQueryOptions({ queryKey: ["probe"], queryFn }, FALLBACK_INTERVAL_MS),
  );
  return <div data-testid="probe" data-fetch-status={query.status} />;
}

function renderProbe(queryFn: () => Promise<number>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <IsolatedFallbackQueryProbe queryFn={queryFn} />
    </QueryClientProvider>,
  );
}

describe("useRealtimeAwareQueryOptions - reactive polling fallback (correctness-review round 4)", () => {
  beforeEach(() => {
    resetRealtimeTransportStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRealtimeTransportStateForTests();
  });

  it("full lifecycle: no polling while LIVE, polling starts automatically on POLLING with no manual re-render, polling stops automatically back on LIVE", async () => {
    setRealtimeTransportState("LIVE");
    const fetchSpy = vi.fn(() => Promise.resolve(Date.now()));
    renderProbe(fetchSpy);

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-fetch-status", "success"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();

    // 1-5: LIVE - advancing well past several fallback intervals must NOT poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS * 5);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 6-9: flip the store directly - NO manual re-render of THIS TEST's own
    // making (no useRealtimeStatus() anywhere in this tree, no second
    // subscription this test drives itself). `act()` here wraps the store's
    // OWN notification to its `useSyncExternalStore` listener - the real
    // React update the fix is supposed to produce, not a test-authored one.
    // If the query helper is properly reactive, its OWN internal
    // subscription must pick this up on its own.
    act(() => {
      setRealtimeTransportState("POLLING");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS * 5);
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);

    // 10-11: flip back to LIVE - polling must stop automatically again.
    const countAtPollingStop = fetchSpy.mock.calls.length;
    act(() => {
      setRealtimeTransportState("LIVE");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS * 5);
    });
    expect(fetchSpy.mock.calls.length).toBe(countAtPollingStop);
  });
});
