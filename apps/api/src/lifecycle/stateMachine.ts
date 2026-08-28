/**
 * Guild lifecycle state machine (Step 10, IMPLEMENTATION/10_onboarding_approval.md,
 * DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md §Guild Lifecycle State Machine
 * (D-009)). Pure, side-effect-free — this module never touches the database;
 * `lifecycleService.ts` is the ONLY caller that combines this with a real,
 * row_version-guarded write.
 *
 * The full diagram (mermaid, DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md):
 *
 *   DISCOVERED --> CONFIGURING              (Guild Admin's first onboarding edit)
 *   CONFIGURING --> PENDING_APPROVAL        (Guild Admin: "Request activation")
 *   PENDING_APPROVAL --> CHANGES_REQUESTED  (Superadmin, with reason)
 *   CHANGES_REQUESTED --> PENDING_APPROVAL  (Guild Admin re-submits)
 *   PENDING_APPROVAL --> ACTIVE             (Superadmin approves)
 *   PENDING_APPROVAL --> REJECTED           (Superadmin rejects, with reason)
 *   REJECTED --> CONFIGURING                (Guild Admin re-opens)
 *   ACTIVE --> USER_PAUSED                  (Guild Admin/"Owner" pauses)
 *   USER_PAUSED --> ACTIVE                  (Guild Admin/"Owner" resumes, no re-approval)
 *   ACTIVE --> PLATFORM_SUSPENDED           (Superadmin suspends, suspended_from_state=ACTIVE)
 *   USER_PAUSED --> PLATFORM_SUSPENDED      (Superadmin suspends, suspended_from_state=USER_PAUSED)
 *   PLATFORM_SUSPENDED --> ACTIVE|USER_PAUSED (Superadmin lifts, restores suspended_from_state)
 *
 * NOT modeled here (out of this step's scope, DÉPÔTS: "bunny-command-center
 * only for this step's own work"): `CONFIGURING --> [*]` ("guild removes the
 * bot, config retained, dormant") is an externally-observed Discord event
 * (a bot leaving a guild), not a Dashboard user action — there is no
 * Dashboard API route that could trigger it, and inventing one with no real
 * caller would violate 00_GLOBAL_IMPLEMENTATION_RULES.md rule 6 ("tests are
 * not proof of wiring"). Left as a documented gap, not silently assumed
 * equivalent to any modeled action.
 *
 * RBAC note (CORRECTED, Step 10 correction round Gap 1 — this module's prior
 * comment here was wrong): the diagram's prose says "Guild Owner" for
 * pause/resume, and that IS meant literally — a real, separate check from
 * `GUILD_ADMIN` tier. `requiredTier: "GUILD_ADMIN"` below for `PAUSE`/`RESUME`
 * is deliberately left as-is (it stays a valid, necessary defense-in-depth
 * floor: a genuine Owner always resolves to `GUILD_ADMIN` tier via
 * `resolveGuildAuthorization`'s own Owner branch, and Superadmin resolves to
 * the higher `SUPERADMIN` rank, so both legitimately pass this check) — but
 * it is NOT sufficient on its own: `GUILD_ADMIN` tier is also reachable via
 * the configured admin role or the Discord ADMINISTRATOR permission bit,
 * neither of which implies Owner-ness. The REAL Owner-vs-not gate lives one
 * layer up, at the route (`lifecycle/routes.ts`'s `requireOwner` preHandler,
 * built from `auth/tier.ts`'s `buildRequireGuildOwner`) — this module has no
 * access to the raw Discord "is this caller the Owner" fact itself (it is
 * pure/side-effect-free, per this header's own first paragraph), so it
 * cannot enforce that half of the check itself. `REOPEN` genuinely IS
 * plain-`GUILD_ADMIN`-scoped (verified against
 * DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md's "REJECTED --> CONFIGURING:
 * Guild Admin may re-open" — no "Owner" qualifier there) and needed no
 * change.
 */
import type { GuildTier } from "../auth/guildAuthorization.js";

export const LIFECYCLE_STATES = [
  "DISCOVERED",
  "CONFIGURING",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "ACTIVE",
  "USER_PAUSED",
  "PLATFORM_SUSPENDED",
  "REJECTED",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** States in which `guilds.enabled` must be 1 — exactly `ACTIVE`, per the single-writer lockstep design (DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md §Guild Lifecycle Durable Source: "= 1 iff transitioning to ACTIVE, = 0 otherwise"). */
export function enabledForState(state: LifecycleState): 0 | 1 {
  return state === "ACTIVE" ? 1 : 0;
}

export const LIFECYCLE_ACTIONS = [
  "START_CONFIGURING",
  "REQUEST_ACTIVATION",
  "REQUEST_CHANGES",
  "RESUBMIT_ACTIVATION",
  "APPROVE",
  "REJECT",
  "REOPEN",
  "PAUSE",
  "RESUME",
  "SUSPEND",
  "LIFT_SUSPENSION",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export interface LifecycleTransitionContext {
  readonly currentState: LifecycleState;
  /** Only meaningful while `currentState === "PLATFORM_SUSPENDED"`; `null` otherwise. */
  readonly suspendedFromState: LifecycleState | null;
}

export interface LifecycleTransitionOutcome {
  readonly nextState: LifecycleState;
  readonly nextSuspendedFromState: LifecycleState | null;
}

export type LifecycleTransitionError =
  | { readonly ok: false; readonly errorCode: "ILLEGAL_TRANSITION" }
  | { readonly ok: false; readonly errorCode: "INSUFFICIENT_TIER" }
  | { readonly ok: false; readonly errorCode: "CORRUPT_SUSPENSION_STATE" };

export type LifecycleTransitionResult =
  ({ readonly ok: true } & LifecycleTransitionOutcome) | LifecycleTransitionError;

interface TransitionRule {
  readonly from: readonly LifecycleState[];
  readonly requiredTier: GuildTier;
  readonly resolve: (
    ctx: LifecycleTransitionContext,
  ) => LifecycleTransitionOutcome | { error: "CORRUPT_SUSPENSION_STATE" };
}

const SIMPLE =
  (nextState: LifecycleState): TransitionRule["resolve"] =>
  () => ({
    nextState,
    nextSuspendedFromState: null,
  });

const TRANSITIONS: Record<LifecycleAction, TransitionRule> = {
  START_CONFIGURING: { from: ["DISCOVERED"], requiredTier: "GUILD_ADMIN", resolve: SIMPLE("CONFIGURING") },
  REQUEST_ACTIVATION: {
    from: ["CONFIGURING"],
    requiredTier: "GUILD_ADMIN",
    resolve: SIMPLE("PENDING_APPROVAL"),
  },
  REQUEST_CHANGES: {
    from: ["PENDING_APPROVAL"],
    requiredTier: "SUPERADMIN",
    resolve: SIMPLE("CHANGES_REQUESTED"),
  },
  RESUBMIT_ACTIVATION: {
    from: ["CHANGES_REQUESTED"],
    requiredTier: "GUILD_ADMIN",
    resolve: SIMPLE("PENDING_APPROVAL"),
  },
  APPROVE: { from: ["PENDING_APPROVAL"], requiredTier: "SUPERADMIN", resolve: SIMPLE("ACTIVE") },
  REJECT: { from: ["PENDING_APPROVAL"], requiredTier: "SUPERADMIN", resolve: SIMPLE("REJECTED") },
  REOPEN: { from: ["REJECTED"], requiredTier: "GUILD_ADMIN", resolve: SIMPLE("CONFIGURING") },
  PAUSE: { from: ["ACTIVE"], requiredTier: "GUILD_ADMIN", resolve: SIMPLE("USER_PAUSED") },
  RESUME: { from: ["USER_PAUSED"], requiredTier: "GUILD_ADMIN", resolve: SIMPLE("ACTIVE") },
  SUSPEND: {
    from: ["ACTIVE", "USER_PAUSED"],
    requiredTier: "SUPERADMIN",
    resolve: (ctx) => ({ nextState: "PLATFORM_SUSPENDED", nextSuspendedFromState: ctx.currentState }),
  },
  LIFT_SUSPENSION: {
    from: ["PLATFORM_SUSPENDED"],
    requiredTier: "SUPERADMIN",
    // Corrected 2026-08-11 (second pass, DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md):
    // restores EXACTLY the state the guild was in before the platform
    // suspension, never unconditionally ACTIVE.
    resolve: (ctx) => {
      if (ctx.suspendedFromState !== "ACTIVE" && ctx.suspendedFromState !== "USER_PAUSED") {
        return { error: "CORRUPT_SUSPENSION_STATE" };
      }
      return { nextState: ctx.suspendedFromState, nextSuspendedFromState: null };
    },
  },
};

/**
 * The ONE place transition legality + RBAC + suspension-restore correctness
 * is decided. `callerTier` is checked ONLY after the transition is confirmed
 * structurally legal (mirrors `requireTier`'s own "membership before tier"
 * ordering discipline — an illegal transition is a 409-shaped client error
 * regardless of who attempted it, never conflated with a 403).
 */
export function applyLifecycleTransition(
  action: LifecycleAction,
  ctx: LifecycleTransitionContext,
  callerTier: GuildTier,
): LifecycleTransitionResult {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(ctx.currentState)) {
    return { ok: false, errorCode: "ILLEGAL_TRANSITION" };
  }
  const outcome = rule.resolve(ctx);
  if ("error" in outcome) {
    return { ok: false, errorCode: outcome.error };
  }
  const GUILD_TIER_RANK: Record<GuildTier, number> = { USER: 0, GUILD_ADMIN: 1, SUPERADMIN: 2 };
  if (GUILD_TIER_RANK[callerTier] < GUILD_TIER_RANK[rule.requiredTier]) {
    return { ok: false, errorCode: "INSUFFICIENT_TIER" };
  }
  return { ok: true, ...outcome };
}

/** Every state this action could legally originate FROM — used by tests and by the repo layer's own defensive assertions. */
export function legalSourceStatesFor(action: LifecycleAction): readonly LifecycleState[] {
  return TRANSITIONS[action].from;
}

export function requiredTierFor(action: LifecycleAction): GuildTier {
  return TRANSITIONS[action].requiredTier;
}
