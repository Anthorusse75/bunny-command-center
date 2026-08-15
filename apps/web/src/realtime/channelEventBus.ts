// Client-side fan-out from "one real SSE frame" to "every React component
// that called `useRealtimeChannel(eventType, handler)`" - the counterpart to
// apps/api/src/sse/registry.ts's server-side registry. A module-level
// singleton, matching realtimeStatusStore.ts's reasoning (one per tab).
type Handler = (data: unknown) => void;

const handlersByType = new Map<string, Set<Handler>>();

export function subscribeChannelEvent(eventType: string, handler: Handler): () => void {
  if (!handlersByType.has(eventType)) {
    handlersByType.set(eventType, new Set());
  }
  handlersByType.get(eventType)!.add(handler);
  return () => {
    handlersByType.get(eventType)?.delete(handler);
  };
}

export function dispatchChannelEvent(eventType: string, data: unknown): void {
  const handlers = handlersByType.get(eventType);
  if (!handlers) {
    return;
  }
  for (const handler of handlers) {
    handler(data);
  }
}

export function resetChannelEventBusForTests(): void {
  handlersByType.clear();
}
