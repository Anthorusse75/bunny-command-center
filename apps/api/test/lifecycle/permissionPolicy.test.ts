/**
 * Step 10 external-review correction round, Section 14 — exhaustive unit
 * tests for `permissionPolicy.ts`'s per-state capability matrix: every
 * state x every capability, asserting the EXACT expected boolean against
 * `DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md`'s "Per-state permission
 * matrix" table (reproduced in `permissionPolicy.ts`'s own header comment,
 * including the one documented prose-vs-diagram discrepancy for
 * `REJECTED`'s `requestActivationAllowed`).
 */
import { describe, expect, it } from "vitest";
import { lifecyclePermissionsFor, type LifecyclePermissions } from "../../src/lifecycle/permissionPolicy.js";
import { LIFECYCLE_STATES, type LifecycleState } from "../../src/lifecycle/stateMachine.js";

const EXPECTED: Record<LifecycleState, LifecyclePermissions> = {
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

describe("permissionPolicy — exhaustive per-state capability matrix (Section 14)", () => {
  it.each(LIFECYCLE_STATES)("state %s matches the documented matrix exactly", (state) => {
    expect(lifecyclePermissionsFor(state)).toEqual(EXPECTED[state]);
  });

  it("exactly one state (ACTIVE) allows pause, and exactly one (USER_PAUSED) allows resume", () => {
    const pauseStates = LIFECYCLE_STATES.filter((s) => lifecyclePermissionsFor(s).pauseAllowed);
    const resumeStates = LIFECYCLE_STATES.filter((s) => lifecyclePermissionsFor(s).resumeAllowed);
    expect(pauseStates).toEqual(["ACTIVE"]);
    expect(resumeStates).toEqual(["USER_PAUSED"]);
  });

  it("exactly one state (ACTIVE) allows real ingestion / hero sends", () => {
    const realIngestionStates = LIFECYCLE_STATES.filter(
      (s) => lifecyclePermissionsFor(s).realIngestionAllowed,
    );
    const heroSendStates = LIFECYCLE_STATES.filter((s) => lifecyclePermissionsFor(s).heroSendAllowed);
    expect(realIngestionStates).toEqual(["ACTIVE"]);
    expect(heroSendStates).toEqual(["ACTIVE"]);
  });

  it("exactly one state (PLATFORM_SUSPENDED) is not config-editable", () => {
    const notEditable = LIFECYCLE_STATES.filter((s) => !lifecyclePermissionsFor(s).configEditable);
    expect(notEditable).toEqual(["PLATFORM_SUSPENDED"]);
  });

  it("every state has statsVisible = true (content varies, access never gated)", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(lifecyclePermissionsFor(state).statsVisible).toBe(true);
    }
  });

  it("requestActivationAllowed is true only for CONFIGURING and CHANGES_REQUESTED (REJECTED requires REOPEN first — see module header comment)", () => {
    const allowed = LIFECYCLE_STATES.filter((s) => lifecyclePermissionsFor(s).requestActivationAllowed);
    expect(allowed.sort()).toEqual(["CHANGES_REQUESTED", "CONFIGURING"]);
  });
});
