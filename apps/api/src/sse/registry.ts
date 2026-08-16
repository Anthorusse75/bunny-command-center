// The two generic extension points every later realtime-consuming step uses
// (03_realtime_infrastructure.md HANDOVER FORMAT requires documenting this
// file:line explicitly):
//
//   1. `registerEventType(...)`  - declares a new SSE event's name + Zod
//      payload schema (mission §10/§43: every event is validated before
//      fan-out; a malformed payload is rejected here, not fanned out).
//   2. `registerSourceAdapter(...)` - plugs a durable table into the poller
//      (apps/api/src/sse/poller.ts) so its rows become SSE events.
//
// This file is deliberately the ONLY place either registry lives - it must
// never itself import or mention a feature-specific event/table name
// (03_realtime_infrastructure.md REJECTION CRITERIA).
import type { ZodType } from "zod";
import type { SourceAdapter } from "./types.js";
import { HEARTBEAT_SOURCE_INDEX } from "./types.js";

export interface RegisteredEventType {
  readonly type: string;
  readonly schema: ZodType;
}

const eventTypes = new Map<string, RegisteredEventType>();
const sourceAdaptersByTable = new Map<string, SourceAdapter>();
const sourceIndexesInUse = new Map<number, string>();

export function registerEventType(entry: RegisteredEventType): void {
  if (eventTypes.has(entry.type)) {
    throw new Error(`SSE event type already registered: ${entry.type}`);
  }
  eventTypes.set(entry.type, entry);
}

export function getEventType(type: string): RegisteredEventType | undefined {
  return eventTypes.get(type);
}

export function registerSourceAdapter(adapter: SourceAdapter): void {
  // Runtime invariants on sourceIndex (correctness-review defect 8): a
  // registering adapter's sourceIndex is a fixed constant chosen by the
  // REGISTERING code (types.ts's own doc comment), never runtime-derived -
  // so an invalid value here is a genuine programming bug, caught at
  // registration time (server startup) rather than surfacing later as a
  // corrupt wire id or a silent misattribution between two adapters.
  if (!Number.isSafeInteger(adapter.sourceIndex)) {
    throw new Error(
      `SSE source adapter "${adapter.sourceTable}" has a non-safe-integer sourceIndex: ${String(adapter.sourceIndex)}`,
    );
  }
  if (adapter.sourceIndex === HEARTBEAT_SOURCE_INDEX) {
    throw new Error(`sourceIndex ${HEARTBEAT_SOURCE_INDEX} is reserved for heartbeat frames`);
  }
  if (adapter.sourceIndex < 0) {
    throw new Error(
      `SSE source adapter "${adapter.sourceTable}" has a negative sourceIndex (${adapter.sourceIndex}) - business adapters must use a positive sourceIndex (0 is reserved for heartbeat)`,
    );
  }
  if (adapter.sourceTable.length > 64) {
    throw new Error(
      `source_table name too long for dashboard_sse_cursor.source_table: ${adapter.sourceTable}`,
    );
  }
  if (sourceAdaptersByTable.has(adapter.sourceTable)) {
    throw new Error(`SSE source adapter already registered for table: ${adapter.sourceTable}`);
  }
  const existingOwner = sourceIndexesInUse.get(adapter.sourceIndex);
  if (existingOwner !== undefined) {
    throw new Error(
      `sourceIndex ${adapter.sourceIndex} already used by adapter "${existingOwner}", cannot reuse for "${adapter.sourceTable}"`,
    );
  }
  sourceAdaptersByTable.set(adapter.sourceTable, adapter);
  sourceIndexesInUse.set(adapter.sourceIndex, adapter.sourceTable);
}

export function listSourceAdapters(): SourceAdapter[] {
  return [...sourceAdaptersByTable.values()];
}

export function getSourceAdapterByIndex(sourceIndex: number): SourceAdapter | undefined {
  const table = sourceIndexesInUse.get(sourceIndex);
  return table ? sourceAdaptersByTable.get(table) : undefined;
}

/** Test-only reset - both registries are module-level singletons so tests that register a throwaway adapter/event type must clean up after themselves. */
export function resetRegistryForTests(): void {
  eventTypes.clear();
  sourceAdaptersByTable.clear();
  sourceIndexesInUse.clear();
}
