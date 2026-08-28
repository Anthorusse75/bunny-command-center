// Step 10 external-review Phase 2, Section 12 — "Bunny & permissions"
// becomes a live status/checklist derived from real per-channel permission
// facts, replacing the prior manual attestation checkbox. Tests both the
// pure computation (`computeBunnyPermissionsStatus`) and its rendering
// (`BunnyPermissionsSection`), matching the orchestrator's explicit test
// list: missing-permission -> incomplete, Bunny unavailable -> degraded
// (never a false pass), all-present -> complete, and cross-guild isolation.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OnboardingChannelCatalogResponse, OnboardingChannelDto } from "@bunny-command-center/shared";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import {
  computeBunnyPermissionsStatus,
  BunnyPermissionsSection,
  type BunnyPermissionsStatus,
} from "../OnboardingScreen.js";

function channel(overrides: Partial<OnboardingChannelDto> = {}): OnboardingChannelDto {
  return {
    id: "500000000000000001",
    name: "general",
    position: 0,
    type: "text",
    canReadHistory: true,
    canViewChannel: true,
    canSendMessages: true,
    ...overrides,
  };
}

function catalog(channels: OnboardingChannelDto[], available = true): OnboardingChannelCatalogResponse {
  return { available, channels };
}

describe("computeBunnyPermissionsStatus", () => {
  it("degrades (never a false pass) when the catalog is still loading", () => {
    expect(computeBunnyPermissionsStatus(undefined, true, "500000000000000001", null)).toEqual({
      kind: "degraded",
    });
  });

  it("degrades when Bunny is unreachable (available: false)", () => {
    const result = computeBunnyPermissionsStatus(catalog([], false), false, "500000000000000001", null);
    expect(result).toEqual({ kind: "degraded" });
  });

  it("degrades when no catalog data exists at all (query not yet resolved, not loading)", () => {
    expect(computeBunnyPermissionsStatus(undefined, false, "500000000000000001", null)).toEqual({
      kind: "degraded",
    });
  });

  it("reports incomplete with the specific failing check when the incoming channel is missing a required permission", () => {
    const incoming = channel({ id: "500000000000000001", canSendMessages: false });
    const result = computeBunnyPermissionsStatus(
      catalog([incoming]),
      false,
      "500000000000000001",
      null,
    ) as Extract<BunnyPermissionsStatus, { kind: "checked" }>;

    expect(result.kind).toBe("checked");
    expect(result.complete).toBe(false);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]!.role).toBe("incoming");
    expect(result.channels[0]!.found).toBe(true);
    const sendCheck = result.channels[0]!.checks.find((c) => c.key === "sendMessages");
    expect(sendCheck?.pass).toBe(false);
    const viewCheck = result.channels[0]!.checks.find((c) => c.key === "viewChannel");
    expect(viewCheck?.pass).toBe(true);
  });

  it("reports complete when the incoming channel has all 3 required permissions and no community channel is configured", () => {
    const incoming = channel({ id: "500000000000000001" });
    const result = computeBunnyPermissionsStatus(catalog([incoming]), false, "500000000000000001", null);
    expect(result).toEqual({
      kind: "checked",
      complete: true,
      channels: [
        {
          role: "incoming",
          channelId: "500000000000000001",
          found: true,
          checks: [
            { key: "viewChannel", pass: true },
            { key: "readHistory", pass: true },
            { key: "sendMessages", pass: true },
          ],
        },
      ],
    });
  });

  it("the community channel is existence-only when configured — no Bunny permission requirement, since Bunny has no real .send() consumer targeting it", () => {
    const incoming = channel({ id: "500000000000000001" });
    const community = channel({ id: "500000000000000002", canSendMessages: false, canViewChannel: false });
    const result = computeBunnyPermissionsStatus(
      catalog([incoming, community]),
      false,
      "500000000000000001",
      "500000000000000002",
    ) as Extract<BunnyPermissionsStatus, { kind: "checked" }>;

    // Incoming still fully satisfied and community merely exists — overall
    // complete despite community holding NO Bunny permissions at all.
    expect(result.complete).toBe(true);
    const communityStatus = result.channels.find((c) => c.role === "community")!;
    expect(communityStatus.found).toBe(true);
    expect(communityStatus.checks).toEqual([]);
  });

  it("flags a configured channel id no longer present in the live catalog as not found, never fabricating a pass", () => {
    const result = computeBunnyPermissionsStatus(
      catalog([channel({ id: "500000000000000099" })]),
      false,
      "500000000000000001", // not in the catalog above
      null,
    ) as Extract<BunnyPermissionsStatus, { kind: "checked" }>;

    expect(result.complete).toBe(false);
    expect(result.channels[0]!.found).toBe(false);
    expect(result.channels[0]!.checks.every((c) => c.pass === false)).toBe(true);
  });

  it("cross-guild isolation: guild A's result never reflects guild B's catalog/channel ids", () => {
    const guildACatalog = catalog([channel({ id: "500000000000000001", name: "a-incoming" })]);
    const guildBCatalog = catalog([
      channel({ id: "500000000000000002", name: "b-incoming", canReadHistory: false }),
    ]);

    const resultA = computeBunnyPermissionsStatus(guildACatalog, false, "500000000000000001", null);
    const resultB = computeBunnyPermissionsStatus(guildBCatalog, false, "500000000000000002", null);

    expect(resultA).toEqual({
      kind: "checked",
      complete: true,
      channels: [
        {
          role: "incoming",
          channelId: "500000000000000001",
          found: true,
          checks: [
            { key: "viewChannel", pass: true },
            { key: "readHistory", pass: true },
            { key: "sendMessages", pass: true },
          ],
        },
      ],
    });
    // Guild B's channel fails readHistory - proves resultA (computed first,
    // from a completely different catalog object) was never mutated or
    // shared, and guild A's own "complete: true" is untouched by B's data.
    expect((resultB as Extract<BunnyPermissionsStatus, { kind: "checked" }>).complete).toBe(false);
    expect((resultA as Extract<BunnyPermissionsStatus, { kind: "checked" }>).complete).toBe(true);
  });
});

function renderSection(status: BunnyPermissionsStatus): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <BunnyPermissionsSection status={status} />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("BunnyPermissionsSection rendering", () => {
  it("degraded: shows the degraded warning, never a channel checklist", () => {
    renderSection({ kind: "degraded" });
    expect(screen.getByTestId("bunnyPermissions-degraded")).toHaveTextContent(
      i18next.t("onboarding.sections.bunnyPermissions.degraded"),
    );
    expect(screen.queryByTestId("bunnyPermissions-incoming")).not.toBeInTheDocument();
  });

  it("no channels configured yet: shows the guidance message", () => {
    renderSection({ kind: "checked", complete: false, channels: [] });
    expect(
      screen.getByText(i18next.t("onboarding.sections.bunnyPermissions.noChannelsConfigured")),
    ).toBeInTheDocument();
  });

  it("incomplete: renders a failing check with data-pass=false, never silently hiding it", () => {
    renderSection({
      kind: "checked",
      complete: false,
      channels: [
        {
          role: "incoming",
          channelId: "500000000000000001",
          found: true,
          checks: [
            { key: "viewChannel", pass: true },
            { key: "readHistory", pass: true },
            { key: "sendMessages", pass: false },
          ],
        },
      ],
    });
    expect(screen.getByTestId("bunnyPermissions-check-incoming-sendMessages")).toHaveAttribute(
      "data-pass",
      "false",
    );
    expect(screen.getByTestId("bunnyPermissions-check-incoming-viewChannel")).toHaveAttribute(
      "data-pass",
      "true",
    );
  });

  it("channel not found in the live catalog: shows the not-found message instead of a checklist", () => {
    renderSection({
      kind: "checked",
      complete: false,
      channels: [{ role: "incoming", channelId: "500000000000000001", found: false, checks: [] }],
    });
    expect(
      screen.getByText(i18next.t("onboarding.sections.bunnyPermissions.channelNotFound")),
    ).toBeInTheDocument();
  });

  it("complete: every check renders with data-pass=true", () => {
    renderSection({
      kind: "checked",
      complete: true,
      channels: [
        {
          role: "incoming",
          channelId: "500000000000000001",
          found: true,
          checks: [
            { key: "viewChannel", pass: true },
            { key: "readHistory", pass: true },
            { key: "sendMessages", pass: true },
          ],
        },
      ],
    });
    for (const key of ["viewChannel", "readHistory", "sendMessages"]) {
      expect(screen.getByTestId(`bunnyPermissions-check-incoming-${key}`)).toHaveAttribute(
        "data-pass",
        "true",
      );
    }
  });
});
