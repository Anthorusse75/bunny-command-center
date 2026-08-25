/**
 * Exhaustive state-machine unit tests (IMPLEMENTATION/10_onboarding_approval.md
 * §TESTS REQUIRED: "every legal/illegal transition tested, including both
 * PLATFORM_SUSPENDED exits"). Pure — no database, no Fastify.
 */
import { describe, expect, it } from "vitest";
import {
  applyLifecycleTransition,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_STATES,
  enabledForState,
  legalSourceStatesFor,
  requiredTierFor,
  type LifecycleState,
} from "../../src/lifecycle/stateMachine.js";

/** For every action, every state NOT in its legal `from` set — a superadmin caller is used so INSUFFICIENT_TIER can never mask ILLEGAL_TRANSITION in these cases. */
function illegalSourceStatesFor(action: (typeof LIFECYCLE_ACTIONS)[number]): LifecycleState[] {
  const legal = new Set(legalSourceStatesFor(action));
  return LIFECYCLE_STATES.filter((s) => !legal.has(s));
}

describe("stateMachine — exhaustive legal transitions", () => {
  it.each(LIFECYCLE_ACTIONS)("action %s succeeds from every documented legal source state", (action) => {
    for (const from of legalSourceStatesFor(action)) {
      const suspendedFromState: LifecycleState | null = from === "PLATFORM_SUSPENDED" ? "ACTIVE" : null;
      const result = applyLifecycleTransition(
        action,
        { currentState: from, suspendedFromState },
        requiredTierFor(action),
      );
      expect(result.ok, `${action} from ${from} should succeed`).toBe(true);
    }
  });
});

describe("stateMachine — exhaustive illegal transitions", () => {
  it.each(LIFECYCLE_ACTIONS)("action %s is rejected from every non-legal source state", (action) => {
    for (const from of illegalSourceStatesFor(action)) {
      const result = applyLifecycleTransition(
        action,
        { currentState: from, suspendedFromState: from === "PLATFORM_SUSPENDED" ? "ACTIVE" : null },
        "SUPERADMIN",
      );
      expect(result.ok, `${action} from ${from} should be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("ILLEGAL_TRANSITION");
      }
    }
  });
});

describe("stateMachine — RBAC enforcement per action", () => {
  it.each(LIFECYCLE_ACTIONS)("action %s is rejected for a caller below its required tier", (action) => {
    const [from] = legalSourceStatesFor(action);
    const requiredTier = requiredTierFor(action);
    const belowTier = requiredTier === "SUPERADMIN" ? "GUILD_ADMIN" : "USER";
    const result = applyLifecycleTransition(
      action,
      { currentState: from!, suspendedFromState: from === "PLATFORM_SUSPENDED" ? "ACTIVE" : null },
      belowTier,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("INSUFFICIENT_TIER");
    }
  });

  it("an illegal transition is reported as ILLEGAL_TRANSITION even for an under-tiered caller (structural legality checked first)", () => {
    const result = applyLifecycleTransition(
      "APPROVE",
      { currentState: "ACTIVE", suspendedFromState: null },
      "USER",
    );
    expect(result).toEqual({ ok: false, errorCode: "ILLEGAL_TRANSITION" });
  });
});

describe("stateMachine — PLATFORM_SUSPENDED entry records suspended_from_state correctly", () => {
  it("SUSPEND from ACTIVE records suspended_from_state=ACTIVE", () => {
    const result = applyLifecycleTransition(
      "SUSPEND",
      { currentState: "ACTIVE", suspendedFromState: null },
      "SUPERADMIN",
    );
    expect(result).toEqual({ ok: true, nextState: "PLATFORM_SUSPENDED", nextSuspendedFromState: "ACTIVE" });
  });

  it("SUSPEND from USER_PAUSED records suspended_from_state=USER_PAUSED", () => {
    const result = applyLifecycleTransition(
      "SUSPEND",
      { currentState: "USER_PAUSED", suspendedFromState: null },
      "SUPERADMIN",
    );
    expect(result).toEqual({
      ok: true,
      nextState: "PLATFORM_SUSPENDED",
      nextSuspendedFromState: "USER_PAUSED",
    });
  });
});

describe("stateMachine — both PLATFORM_SUSPENDED exits restore the correct pre-suspension state (the corrected behavior)", () => {
  it("lifting a suspension that came from ACTIVE restores ACTIVE, never silently something else", () => {
    const result = applyLifecycleTransition(
      "LIFT_SUSPENSION",
      { currentState: "PLATFORM_SUSPENDED", suspendedFromState: "ACTIVE" },
      "SUPERADMIN",
    );
    expect(result).toEqual({ ok: true, nextState: "ACTIVE", nextSuspendedFromState: null });
  });

  it("lifting a suspension that came from USER_PAUSED restores USER_PAUSED, NOT ACTIVE (the bug this design fixed)", () => {
    const result = applyLifecycleTransition(
      "LIFT_SUSPENSION",
      { currentState: "PLATFORM_SUSPENDED", suspendedFromState: "USER_PAUSED" },
      "SUPERADMIN",
    );
    expect(result).toEqual({ ok: true, nextState: "USER_PAUSED", nextSuspendedFromState: null });
  });

  it("lifting a suspension with a corrupt/missing suspended_from_state fails closed rather than guessing ACTIVE", () => {
    const result = applyLifecycleTransition(
      "LIFT_SUSPENSION",
      { currentState: "PLATFORM_SUSPENDED", suspendedFromState: null },
      "SUPERADMIN",
    );
    expect(result).toEqual({ ok: false, errorCode: "CORRUPT_SUSPENSION_STATE" });
  });
});

describe("enabledForState", () => {
  it.each(LIFECYCLE_STATES)("enabled is 1 iff state is ACTIVE (state=%s)", (state) => {
    expect(enabledForState(state)).toBe(state === "ACTIVE" ? 1 : 0);
  });
});
