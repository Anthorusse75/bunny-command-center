import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_PREFERENCE_GROUPS,
  NOTIFICATION_EVENT_REGISTRY,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_GROUP_EVENT_TYPES,
  NOTIFICATION_PREFERENCE_GROUPS,
  getNotificationEventDefinition,
} from "../src/constants/notifications.js";
import { notificationIdSchema, notificationListQuerySchema } from "../src/types/notifications.js";
import en from "../src/i18n/en.json" with { type: "json" };
import fr from "../src/i18n/fr.json" with { type: "json" };
import de from "../src/i18n/de.json" with { type: "json" };

function hasNestedKey(obj: unknown, dottedPath: string): boolean {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor !== null && typeof cursor === "object" && part in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return false;
    }
  }
  return typeof cursor === "string";
}

describe("NOTIFICATION_EVENT_REGISTRY — completeness (Step 09 task brief's required event set)", () => {
  it("covers exactly the 11 events named in 18_NOTIFICATIONS_AND_DISCORD_DM.md's matrix", () => {
    expect(NOTIFICATION_EVENT_TYPES).toHaveLength(11);
    expect(new Set(NOTIFICATION_EVENT_TYPES).size).toBe(11); // no duplicates
  });

  it.each(NOTIFICATION_EVENT_TYPES)(
    "%s has a real, non-empty i18n messageKey with content in the en catalog",
    (eventType) => {
      const def = getNotificationEventDefinition(eventType);
      expect(def.messageKey.length).toBeGreaterThan(0);
      // Plural-suffixed keys (uploadCompleted etc.) resolve via `<key>_other` in
      // the raw JSON — either the bare key or its `_other` sibling must exist.
      const hasBase = hasNestedKey(en, def.messageKey);
      const hasOther = hasNestedKey(en, `${def.messageKey}_other`);
      expect(hasBase || hasOther).toBe(true);
    },
  );

  it.each(NOTIFICATION_EVENT_TYPES)("%s declares a non-empty deeplinkCategory", (eventType) => {
    expect(getNotificationEventDefinition(eventType).deeplinkCategory.length).toBeGreaterThan(0);
  });

  it("every group in NOTIFICATION_PREFERENCE_GROUPS has at least one member event type", () => {
    for (const group of NOTIFICATION_PREFERENCE_GROUPS) {
      expect(NOTIFICATION_GROUP_EVENT_TYPES[group].length).toBeGreaterThan(0);
    }
  });

  it("every grouped event type's registry `group` field matches the group it's listed under", () => {
    for (const group of NOTIFICATION_PREFERENCE_GROUPS) {
      for (const eventType of NOTIFICATION_GROUP_EVENT_TYPES[group]) {
        expect(NOTIFICATION_EVENT_REGISTRY[eventType].group).toBe(group);
      }
    }
  });

  it("NEW_GUILD_PENDING and HERO_DISCOVERY_CANDIDATE_READY are intentionally ungrouped (documented deviation — see constants/notifications.ts's header comment)", () => {
    expect(NOTIFICATION_EVENT_REGISTRY.NEW_GUILD_PENDING.group).toBeNull();
    expect(NOTIFICATION_EVENT_REGISTRY.HERO_DISCOVERY_CANDIDATE_READY.group).toBeNull();
  });

  it("every OTHER event type has a non-null group (only the two documented Superadmin-only events are ungrouped)", () => {
    const ungrouped = NOTIFICATION_EVENT_TYPES.filter((t) => NOTIFICATION_EVENT_REGISTRY[t].group === null);
    expect(ungrouped.sort()).toEqual(["HERO_DISCOVERY_CANDIDATE_READY", "NEW_GUILD_PENDING"].sort());
  });

  it("documented defaults match 18_NOTIFICATIONS_AND_DISCORD_DM.md's matrix for a representative sample", () => {
    expect(NOTIFICATION_EVENT_REGISTRY.UPLOAD_COMPLETED).toMatchObject({
      defaultInAppEnabled: true,
      defaultDiscordDmEnabled: true,
    });
    expect(NOTIFICATION_EVENT_REGISTRY.BADGE_EARNED).toMatchObject({
      defaultInAppEnabled: true,
      defaultDiscordDmEnabled: false,
    });
    expect(NOTIFICATION_EVENT_REGISTRY.WEEKLY_SUMMARY).toMatchObject({
      defaultInAppEnabled: false,
      defaultDiscordDmEnabled: false,
    });
    expect(NOTIFICATION_EVENT_REGISTRY.ADMIN_ALERT).toMatchObject({
      defaultInAppEnabled: true,
      defaultDiscordDmEnabled: false,
    });
  });
});

describe("PRODUCT CORRECTION — 'Separate admin alert notification preferences' (dashboard/step-09-notifications-system)", () => {
  it("NOTIFICATION_PREFERENCE_GROUPS now has 6 groups, including the new ADMIN_ALERTS", () => {
    expect(NOTIFICATION_PREFERENCE_GROUPS).toHaveLength(6);
    expect(NOTIFICATION_PREFERENCE_GROUPS).toContain("ADMIN_ALERTS");
  });

  it("ADMIN_ALERT maps to ADMIN_ALERTS, its own dedicated group", () => {
    expect(NOTIFICATION_EVENT_REGISTRY.ADMIN_ALERT.group).toBe("ADMIN_ALERTS");
    expect(NOTIFICATION_GROUP_EVENT_TYPES.ADMIN_ALERTS).toEqual(["ADMIN_ALERT"]);
  });

  it("ADMIN_ALERT no longer maps to GUILD_NEEDS", () => {
    expect(NOTIFICATION_EVENT_REGISTRY.ADMIN_ALERT.group).not.toBe("GUILD_NEEDS");
    expect(NOTIFICATION_GROUP_EVENT_TYPES.GUILD_NEEDS).not.toContain("ADMIN_ALERT");
  });

  it("ADMIN_ALERT's documented defaults (in-app ON, Discord DM OFF) are preserved exactly across the group-mapping correction", () => {
    expect(NOTIFICATION_EVENT_REGISTRY.ADMIN_ALERT).toMatchObject({
      defaultInAppEnabled: true,
      defaultDiscordDmEnabled: false,
    });
  });

  it("ADMIN_ALERTS is the only role-gated (admin-only) preference group", () => {
    expect(ADMIN_ONLY_PREFERENCE_GROUPS).toEqual(["ADMIN_ALERTS"]);
  });

  it("REGRESSION: the 5 pre-existing groups and their event-type mappings are completely unchanged by this correction", () => {
    expect(NOTIFICATION_GROUP_EVENT_TYPES.UPLOADS).toEqual(["UPLOAD_COMPLETED", "UPLOAD_PROBLEM"]);
    expect(NOTIFICATION_GROUP_EVENT_TYPES.GUILD_NEEDS).toEqual([
      "URGENT_GUILD_NEED",
      "GUILD_APPROVAL_STATE_CHANGE",
    ]);
    expect(NOTIFICATION_GROUP_EVENT_TYPES.PREMIUMPLUS).toEqual(["PREMIUMPLUS_REACHED"]);
    expect(NOTIFICATION_GROUP_EVENT_TYPES.LEADERBOARD_BADGES).toEqual([
      "BADGE_EARNED",
      "RANKING_TOP3_CHANGE",
    ]);
    expect(NOTIFICATION_GROUP_EVENT_TYPES.WEEKLY_SUMMARY).toEqual(["WEEKLY_SUMMARY"]);
  });

  it("FR/EN/DE labels for every preference group (including the new ADMIN_ALERTS) exist and are non-empty", () => {
    const catalogs = { en, fr, de } as const;
    for (const group of NOTIFICATION_PREFERENCE_GROUPS) {
      for (const [locale, catalog] of Object.entries(catalogs)) {
        const label: unknown = (
          catalog as { notifications: { preferences: { groups: Record<string, string> } } }
        ).notifications.preferences.groups[group];
        expect(typeof label, `${locale}'s label for ${group}`).toBe("string");
        expect((label as string).trim().length, `${locale}'s label for ${group}`).toBeGreaterThan(0);
      }
    }
  });

  it("the ADMIN_ALERTS label is distinct across FR/EN/DE (a genuine translation, not a copy-pasted placeholder)", () => {
    const enLabel = en.notifications.preferences.groups.ADMIN_ALERTS;
    const frLabel = fr.notifications.preferences.groups.ADMIN_ALERTS;
    const deLabel = de.notifications.preferences.groups.ADMIN_ALERTS;
    expect(new Set([enLabel, frLabel, deLabel]).size).toBe(3);
  });
});

describe("Copilot PR review corrections (dashboard/step-09-notifications-system, 62f0b1e correction pass)", () => {
  it("notificationIdSchema — a valid Crockford Base32 CHAR26 id (no I/L/O/U) is accepted", () => {
    // Every char below is a real member of the Crockford alphabet
    // "0123456789ABCDEFGHJKMNPQRSTVWXYZ" — no I, L, O, or U anywhere.
    const valid = "0123456789ABCDEFGHJKMNPQRS";
    expect(valid).toHaveLength(26);
    expect(notificationIdSchema.safeParse(valid).success).toBe(true);
  });

  it("notificationIdSchema — REJECTS a 26-char candidate containing 'U' (Copilot PR review incorrectly claimed the regex admits U; the character class `[0-9A-HJKMNP-TV-Z]` excludes it — P-T is P,Q,R,S,T and V-Z is V,W,X,Y,Z, U is in neither sub-range)", () => {
    // Same valid 25-char prefix as the acceptance test above, with a 'U' appended as the 26th char.
    const withU = "0123456789ABCDEFGHJKMNPQR" + "U";
    expect(withU).toHaveLength(26);
    expect(notificationIdSchema.safeParse(withU).success).toBe(false);
    // Also the simplest possible counter-example: 26 U's.
    expect(notificationIdSchema.safeParse("U".repeat(26)).success).toBe(false);
  });

  it("notificationIdSchema — also rejects the other excluded Crockford letters (I, L, O) for completeness", () => {
    expect(notificationIdSchema.safeParse("I".repeat(26)).success).toBe(false);
    expect(notificationIdSchema.safeParse("L".repeat(26)).success).toBe(false);
    expect(notificationIdSchema.safeParse("O".repeat(26)).success).toBe(false);
  });

  it("notificationListQuerySchema — parse({}) applies both defaults even though each field is also `.optional()` (Copilot PR review incorrectly claimed `.optional()` after `.default()` prevents the default from applying in this Zod version; verified against the real installed zod 4.4.3, not assumed)", () => {
    const result = notificationListQuerySchema.parse({});
    expect(result.limit).toBe(25);
    expect(result.includeDismissed).toBe(false);
  });

  it("notificationListQuerySchema — an explicitly supplied valid limit is honored, not overridden by the default", () => {
    const result = notificationListQuerySchema.parse({ limit: "10" });
    expect(result.limit).toBe(10);
    expect(result.includeDismissed).toBe(false);
  });
});
