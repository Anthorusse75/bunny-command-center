// Public surface of the realtime infrastructure. Future steps consuming SSE
// import from here (or, for the two registration extension points, directly
// from ./registry.js as documented at each call site).
export { SseHub, type SseConnectionHandle } from "./hub.js";
export { buildSseRoutePlugin } from "./route.js";
export { startSsePoller, type SsePollerHandle } from "./poller.js";
export { createSseCursorRepo, type SseCursorRepo } from "./cursorRepo.js";
export {
  registerEventType,
  registerSourceAdapter,
  listSourceAdapters,
  resetRegistryForTests,
} from "./registry.js";
export { getSseMetricsSnapshot, resetSseMetricsForTests } from "./metrics.js";
export type { SourceAdapter, SourceRow } from "./types.js";
export { HEARTBEAT_SOURCE_INDEX, SSE_HUB_CURSOR_KEY } from "./types.js";
