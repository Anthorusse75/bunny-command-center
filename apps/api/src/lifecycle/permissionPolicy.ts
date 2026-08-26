/**
 * Step 10 external-review correction round, Section 14: ONE reusable module
 * answering, for a given `LifecycleState`, the per-state capability
 * questions every other part of this codebase needs — the single source of
 * truth `DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md`'s "Per-state
 * permission matrix" table already documents (read fresh for this work, not
 * from memory — reproduced verbatim in the table below, including its exact
 * column semantics).
 *
 * Source table (`DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md` §Per-state
 * permission matrix):
 *
 * | State | Config editable | Discord scans | Bulk/Discord ingestion | Hero sends | Stats/dashboard visible | Request activation | Pause/Resume |
 * |---|---|---|---|---|---|---|---|
 * | DISCOVERED | yes (starts CONFIGURING on first edit) | no | no | no | yes (empty) | no (must configure first) | n/a |
 * | CONFIGURING | yes | preview/validation only, no real ingestion | no | no | yes | yes, once minimum checklist passes | n/a |
 * | PENDING_APPROVAL | yes (edits allowed, don't reset the request) | preview only | no | no | yes | already pending | n/a |
 * | CHANGES_REQUESTED | yes | preview only | no | no | yes | yes (re-submit) | n/a |
 * | ACTIVE | yes | yes | yes | yes | yes | n/a | Owner: pause |
 * | USER_PAUSED | yes | no | no | no | yes (historical) | n/a | Owner: resume |
 * | REJECTED | yes | preview only | no | no | yes | yes (re-submit as new request) | n/a |
 * | PLATFORM_SUSPENDED | read-only | no | no | no | yes (historical) | n/a | Superadmin only |
 *
 * Column -> capability mapping used below:
 *  - "Config editable"            -> `configEditable`
 *  - "Discord scans"              -> `previewAllowed` (true whenever the row
 *    is NOT the literal "no" — both "yes" and "preview/validation
 *    only"/"preview only" grant SOME form of scanning; a state that permits
 *    the REAL thing trivially also permits the preview form)
 *  - "Bulk/Discord ingestion"     -> `realIngestionAllowed` (true ONLY for
 *    the literal "yes" — ACTIVE is the only state real ingestion ever runs)
 *  - "Hero sends"                 -> `heroSendAllowed`
 *  - "Stats/dashboard visible"    -> `statsVisible` (every row is some form
 *    of "yes" — historical/empty content is a rendering detail, not an
 *    access gate — so this is `true` for every one of the 8 states)
 *  - "Request activation"         -> `requestActivationAllowed`
 *  - "Pause/Resume"                -> `pauseAllowed` / `resumeAllowed`
 *
 * ** Documented discrepancy found while building this module ** (per this
 * mission's "report contradictions rather than silently resolve them"
 * culture): the table's prose for `REJECTED`'s "Request activation" column
 * reads "yes (re-submit as new request)", which taken literally could
 * suggest `REJECTED` itself permits request-activation directly. The SAME
 * document's own state-machine diagram (and this codebase's actual,
 * already-implemented `stateMachine.ts` — the single authoritative
 * transitions table, unchanged by this module) instead requires
 * `REJECTED --> CONFIGURING` (`REOPEN`, a separate mandatory Guild-Admin
 * action) BEFORE `CONFIGURING --> PENDING_APPROVAL` (`REQUEST_ACTIVATION`)
 * becomes legal — `REQUEST_ACTIVATION`'s real `from` array is `["CONFIGURING"]`
 * only, never `["REJECTED"]`, and `activationRequestsService.ts`'s
 * `createActivationRequest` already computes its action as "deliberately
 * invalid" from any state other than `CONFIGURING`/`CHANGES_REQUESTED`
 * (i.e. `REJECTED` is NOT treated as request-activation-eligible in the
 * real, already-working code, and always requires REOPEN first). This
 * module's `requestActivationAllowed` therefore reflects the DIAGRAM/CODE's
 * precise per-state legality (`false` for `REJECTED`, `true` only for
 * `CONFIGURING`/`CHANGES_REQUESTED`), not the table prose's looser
 * "yes (re-submit ...)" wording — the prose is describing the overall
 * two-step user journey (reopen, then resubmit), not a single-state
 * capability. This causes NO real behavior change (the existing code
 * already enforces exactly this via `stateMachine.ts`, so this module's
 * value for `REJECTED` matches what already actually happens) — flagged
 * here as a documentation-wording ambiguity, not a code bug.
 */
import type { LifecycleState } from "./stateMachine.js";

export interface LifecyclePermissions {
  readonly configEditable: boolean;
  readonly previewAllowed: boolean;
  readonly realIngestionAllowed: boolean;
  readonly heroSendAllowed: boolean;
  readonly statsVisible: boolean;
  readonly requestActivationAllowed: boolean;
  readonly pauseAllowed: boolean;
  readonly resumeAllowed: boolean;
}

const MATRIX: Record<LifecycleState, LifecyclePermissions> = {
  DISCOVERED: {
    configEditable: true,
    previewAllowed: false,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    requestActivationAllowed: false,
    pauseAllowed: false,
    resumeAllowed: false,
  },
  CONFIGURING: {
    configEditable: true,
    previewAllowed: true,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    requestActivationAllowed: true,
    pauseAllowed: false,
    resumeAllowed: false,
  },
  PENDING_APPROVAL: {
    configEditable: true,
    previewAllowed: true,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    // "already pending" -- the request already exists; a SECOND
    // request-activation from this exact state is not a legal transition
    // (matches stateMachine.ts's REQUEST_ACTIVATION `from: ["CONFIGURING"]`
    // only).
    requestActivationAllowed: false,
    pauseAllowed: false,
    resumeAllowed: false,
  },
  CHANGES_REQUESTED: {
    configEditable: true,
    previewAllowed: true,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    requestActivationAllowed: true,
    pauseAllowed: false,
    resumeAllowed: false,
  },
  ACTIVE: {
    configEditable: true,
    previewAllowed: true,
    realIngestionAllowed: true,
    heroSendAllowed: true,
    statsVisible: true,
    requestActivationAllowed: false,
    pauseAllowed: true,
    resumeAllowed: false,
  },
  USER_PAUSED: {
    configEditable: true,
    previewAllowed: false,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    requestActivationAllowed: false,
    pauseAllowed: false,
    resumeAllowed: true,
  },
  REJECTED: {
    configEditable: true,
    previewAllowed: true,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    // See this module's header comment -- REOPEN must happen first.
    requestActivationAllowed: false,
    pauseAllowed: false,
    resumeAllowed: false,
  },
  PLATFORM_SUSPENDED: {
    configEditable: false,
    previewAllowed: false,
    realIngestionAllowed: false,
    heroSendAllowed: false,
    statsVisible: true,
    requestActivationAllowed: false,
    pauseAllowed: false,
    resumeAllowed: false,
  },
};

/** The ONE place any Dashboard route/service consults for a per-state capability question — never re-derive an ad-hoc state check elsewhere. */
export function lifecyclePermissionsFor(state: LifecycleState): LifecyclePermissions {
  return MATRIX[state];
}
