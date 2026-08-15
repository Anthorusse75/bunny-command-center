// Step-06 consumer contract (03_realtime_infrastructure.md HANDOVER FORMAT).
export { SseProvider, useRealtimeChannel, useRealtimeStatus, type RealtimeStatus } from "./SseProvider.js";
export { registerQueryInvalidation, unregisterQueryInvalidation } from "./invalidationRegistry.js";
export { createBccQueryClient } from "./queryClient.js";
export { realtimeAwareQueryOptions } from "./realtimeAwareQuery.js";
export { claimEventForToast } from "./multiTabDedup.js";
export { OfflineBanner } from "./OfflineBanner.js";
