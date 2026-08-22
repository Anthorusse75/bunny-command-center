import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_EVENT_REGISTRY,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_GROUP_EVENT_TYPES,
  NOTIFICATION_PREFERENCE_GROUPS,
  getNotificationEventDefinition,
} from "../src/constants/notifications.js";
import en from "../src/i18n/en.json" with { type: "json" };

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

  it.each(NOTIFICATION_EVENT_TYPES)("%s has a real, non-empty i18n messageKey with content in the en catalog", (eventType) => {
    const def = getNotificationEventDefinition(eventType);
    expect(def.messageKey.length).toBeGreaterThan(0);
    // Plural-suffixed keys (uploadCompleted etc.) resolve via `<key>_other` in
    // the raw JSON — either the bare key or its `_other` sibling must exist.
    const hasBase = hasNestedKey(en, def.messageKey);
    const hasOther = hasNestedKey(en, `${def.messageKey}_other`);
    expect(hasBase || hasOther).toBe(true);
  });

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
    expect(NOTIFICATION_EVENT_REGISTRY.UPLOAD_COMPLETED).toMatchObject({ defaultInAppEnabled: true, defaultDiscordDmEnabled: true });
    expect(NOTIFICATION_EVENT_REGISTRY.BADGE_EARNED).toMatchObject({ defaultInAppEnabled: true, defaultDiscordDmEnabled: false });
    expect(NOTIFICATION_EVENT_REGISTRY.WEEKLY_SUMMARY).toMatchObject({ defaultInAppEnabled: false, defaultDiscordDmEnabled: false });
    expect(NOTIFICATION_EVENT_REGISTRY.ADMIN_ALERT).toMatchObject({ defaultInAppEnabled: true, defaultDiscordDmEnabled: false });
  });
});
