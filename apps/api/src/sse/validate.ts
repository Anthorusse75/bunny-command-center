import type { FastifyBaseLogger } from "fastify";
import type { SourceRow } from "./types.js";
import { getEventType } from "./registry.js";

/**
 * Validates a source row's payload against its registered event type's Zod
 * schema before it is ever fanned out to a browser (mission §10: events are
 * validated at the boundary; mission §43: "A malformed event from one
 * source must not crash the entire API ... Use schema validation where the
 * architecture specifies it. Log structured failure with correlation/source
 * context."). Returns `null` for an unregistered event type or a payload
 * that fails validation - the caller (poller.ts / route.ts's replay path)
 * is responsible for skipping-but-still-advancing-past the row so a single
 * poison row can never block a source's entire remaining backlog.
 */
export function validateSourceRow(
  row: SourceRow,
  sourceTable: string,
  logger: FastifyBaseLogger,
): SourceRow | null {
  const eventType = getEventType(row.eventType);
  if (!eventType) {
    logger.warn(
      { sourceTable, eventType: row.eventType, ordinal: row.ordinal },
      "sse: row references an unregistered event type - skipped, cursor still advances past it",
    );
    return null;
  }
  const result = eventType.schema.safeParse(row.data);
  if (!result.success) {
    logger.warn(
      { sourceTable, eventType: row.eventType, ordinal: row.ordinal, issues: result.error.issues.length },
      "sse: row failed payload validation - skipped, cursor still advances past it",
    );
    return null;
  }
  return { ...row, data: result.data };
}
