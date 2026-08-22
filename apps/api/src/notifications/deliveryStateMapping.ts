/**
 * Pure mapping: `operator_commands.state` (+ `last_error_code`) ->
 * `dashboard_notification_deliveries.state`. Used ONLY by the reconciliation
 * watcher (`reconciliationWatcher.ts`) — never by `createNotification()`
 * itself, which only ever writes `PENDING` at enqueue time.
 *
 * Correction #2 (this step's task brief) — the exact contract:
 *   SUCCEEDED                                        -> SENT
 *   FAILED / EXPIRED / CANCELLED                      -> FAILED
 *   FAILED with last_error_code=SEND_DM_DELIVERY_OUTCOME_UNKNOWN -> FAILED
 *     (same bucket as any other FAILED — this is Bunny's own terminal state
 *     for "the DM might have sent, we can't tell"; per the task brief this
 *     must NEVER be re-enqueued or resent, and this mapper's caller
 *     (reconciliationWatcher.ts) never re-enqueues ANYTHING for ANY FAILED
 *     state — observation-only, so the "never resend" invariant holds
 *     structurally for every FAILED case, not just this one)
 *   QUEUED / CLAIMED / RUNNING / RETRY_WAIT / anything else -> PENDING (stays)
 *
 * `SEND_DM_DELIVERY_OUTCOME_UNKNOWN` is exposed as its own exported constant
 * (not hardcoded inline at the one call site) so a unit test can assert this
 * exact real error code — cited against the real Bunny source at
 * `02_NEW_BOT_OCR/functions/operator_command_consumer.py:910-911` — is what
 * this mapper actually branches on, not merely "any FAILED state".
 */

export const SEND_DM_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE = "SEND_DM_DELIVERY_OUTCOME_UNKNOWN";

const TERMINAL_FAILED_STATES = new Set(["FAILED", "EXPIRED", "CANCELLED"]);

export type OperatorCommandState =
  | "QUEUED"
  | "CLAIMED"
  | "RUNNING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | (string & {});

export type MappedDeliveryState = "PENDING" | "SENT" | "FAILED";

export function mapOperatorCommandStateToDeliveryState(params: {
  state: OperatorCommandState;
  lastErrorCode: string | null;
}): MappedDeliveryState {
  if (params.state === "SUCCEEDED") {
    return "SENT";
  }
  if (TERMINAL_FAILED_STATES.has(params.state)) {
    // The SEND_DM_DELIVERY_OUTCOME_UNKNOWN special case lands in the exact
    // same bucket as any other terminal failure — called out explicitly
    // (rather than silently falling through) because the task brief singles
    // it out as load-bearing: this delivery must never be re-enqueued, and
    // this function's caller structurally never re-enqueues on ANY FAILED
    // result, so no special-case branching is actually needed here beyond
    // documenting why.
    return "FAILED";
  }
  // QUEUED / CLAIMED / RUNNING / RETRY_WAIT / any other non-terminal or
  // unrecognized state: stays PENDING. A genuinely unknown state string is
  // deliberately treated as "not yet terminal" rather than thrown on — the
  // watcher's own transient-DB-read-error handling (reconciliationWatcher.ts)
  // is the documented place for "we don't know, leave it PENDING and retry
  // next poll," and an unrecognized state string is the same kind of
  // uncertainty, not a reason to crash the poll tick.
  return "PENDING";
}
