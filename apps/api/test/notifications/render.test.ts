import { describe, expect, it } from "vitest";
import { renderMessage } from "../../src/notifications/render.js";

describe("renderMessage — server-side i18n rendering for the notification message_key/parameters contract", () => {
  it("interpolates a simple {{param}} placeholder for all 3 locales", () => {
    const params = { guildName: "Test Guild" };
    expect(renderMessage("en", "notifications.events.urgentGuildNeed.message", params)).toBe(
      "Test Guild urgently needs more captures",
    );
    expect(renderMessage("fr", "notifications.events.urgentGuildNeed.message", params)).toContain(
      "Test Guild",
    );
    expect(renderMessage("de", "notifications.events.urgentGuildNeed.message", params)).toContain(
      "Test Guild",
    );
  });

  it("resolves the correct plural form per locale at count=0/1/2+ (19_I18N_FR_EN_DE.md's required interpolation/pluralization smoke test)", () => {
    // English: one/other split at 1.
    expect(renderMessage("en", "notifications.events.uploadCompleted.message", { count: 1 })).toBe(
      "Upload completed: 1 screenshot",
    );
    expect(renderMessage("en", "notifications.events.uploadCompleted.message", { count: 2 })).toBe(
      "Upload completed: 2 screenshots",
    );
    // French CLDR: 0 and 1 are BOTH the "one" category (19_I18N_FR_EN_DE.md
    // §Pluralization: "French treats 0 as singular").
    expect(renderMessage("fr", "notifications.events.uploadCompleted.message", { count: 0 })).toBe(
      "Envoi terminé : 0 capture d'écran",
    );
    expect(renderMessage("fr", "notifications.events.uploadCompleted.message", { count: 1 })).toBe(
      "Envoi terminé : 1 capture d'écran",
    );
    expect(renderMessage("fr", "notifications.events.uploadCompleted.message", { count: 5 })).toBe(
      "Envoi terminé : 5 captures d'écran",
    );
    // German: one/other split at 1, same shape as English.
    expect(renderMessage("de", "notifications.events.uploadCompleted.message", { count: 1 })).toBe(
      "Upload abgeschlossen: 1 Screenshot",
    );
    expect(renderMessage("de", "notifications.events.uploadCompleted.message", { count: 3 })).toBe(
      "Upload abgeschlossen: 3 Screenshots",
    );
  });

  it("no raw {{placeholder}} ever leaks into rendered output for a supplied parameter", () => {
    const rendered = renderMessage("en", "notifications.events.badgeEarned.message", {
      badgeName: "500 shots",
    });
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain("500 shots");
  });

  it("falls back to English for a locale with no override and the key is present in EN (defensive — every real locale is always fr/en/de in practice)", () => {
    // @ts-expect-error deliberately passing an unsupported locale to prove the fallback path
    const rendered = renderMessage("xx", "notifications.events.badgeEarned.message", { badgeName: "X" });
    expect(rendered).toBe("You earned a new badge: X");
  });

  it("returns the raw key (never throws) for a genuinely unknown key", () => {
    expect(renderMessage("en", "notifications.events.doesNotExist.message", {})).toBe(
      "notifications.events.doesNotExist.message",
    );
  });

  it("renders the shared DM footer key with a url parameter", () => {
    const rendered = renderMessage("en", "notifications.dm.footer", {
      url: "https://example.com/notifications/preferences",
    });
    expect(rendered).toBe(
      "Manage your notification preferences → https://example.com/notifications/preferences",
    );
  });
});
