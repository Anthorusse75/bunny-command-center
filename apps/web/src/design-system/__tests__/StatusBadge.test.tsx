import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { STATUS_TONES, statusDescriptorForTone } from "@bunny-command-center/shared";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { getThemeTokens } from "../../theme/tokens/index.js";
import { StatusBadge } from "../StatusBadge.js";
import type { BccThemeName, BccModePreference } from "../../theme/tokens/types.js";

function renderBadge(
  ui: React.ReactNode,
  theme: BccThemeName = "fusion",
  mode: BccModePreference = "light",
): void {
  render(
    <BccThemeProvider initialThemeName={theme} initialModePreference={mode}>
      <BccI18nProvider>{ui}</BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("StatusBadge", () => {
  it("renders a translated label for every tone in the shared vocabulary", () => {
    renderBadge(
      <>
        {STATUS_TONES.map((tone) => (
          <StatusBadge key={tone} descriptor={statusDescriptorForTone(tone)} />
        ))}
      </>,
    );
    const badges = screen.getAllByTestId("status-badge");
    expect(badges).toHaveLength(STATUS_TONES.length);
    for (const tone of STATUS_TONES) {
      expect(screen.getByText(i18next.t(`common.status.${tone}`))).toBeVisible();
    }
  });

  it("pairs colour with an icon AND a text label, never colour alone", () => {
    // 28_ACCESSIBILITY.md §Color is never the sole state carrier.
    renderBadge(<StatusBadge tone="error" labelKey="common.status.error" />);
    const badge = screen.getByTestId("status-badge");
    expect(badge).toHaveTextContent(i18next.t("common.status.error"));
    // An SVG icon is present and hidden from assistive tech (the label already says it).
    const icon = badge.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("exposes an accessible name that spells out that this is a status", () => {
    renderBadge(<StatusBadge tone="pending" labelKey="common.status.pending" />);
    expect(
      screen.getByLabelText(i18next.t("a11y.statusLabel", { status: i18next.t("common.status.pending") })),
    ).toBeInTheDocument();
  });

  it("takes its colours from the active theme's status tokens, not from literals", () => {
    renderBadge(<StatusBadge tone="warning" labelKey="common.status.warning" />, "heroic", "dark");
    const badge = screen.getByTestId("status-badge");
    const tokens = getThemeTokens("heroic", "dark");
    // The rule is written with a CSS variable; the variable's value is what proves the token
    // reached the element.
    const style = getComputedStyle(badge);
    expect(style.backgroundColor).toContain("--bcc-palette-bcc-status-warning-surface");
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bcc-palette-bcc-status-warning-surface")
        .trim(),
    ).toBe(tokens.status.warning.surface);
  });

  it("switches the icon set with the theme's icon token (filled for Heroic, outlined for Premium)", () => {
    const { unmount } = render(
      <BccThemeProvider initialThemeName="heroic" initialModePreference="light">
        <BccI18nProvider>
          <StatusBadge tone="success" labelKey="common.status.success" />
        </BccI18nProvider>
      </BccThemeProvider>,
    );
    const heroicPath = screen.getByTestId("status-badge").querySelector("svg path")?.getAttribute("d");
    unmount();

    render(
      <BccThemeProvider initialThemeName="premium" initialModePreference="light">
        <BccI18nProvider>
          <StatusBadge tone="success" labelKey="common.status.success" />
        </BccI18nProvider>
      </BccThemeProvider>,
    );
    const premiumPath = screen.getByTestId("status-badge").querySelector("svg path")?.getAttribute("d");

    expect(heroicPath).toBeTruthy();
    expect(premiumPath).toBeTruthy();
    // Different glyph geometry = genuinely a different (filled vs outlined) icon, not a
    // recoloured copy of the same one.
    expect(heroicPath).not.toBe(premiumPath);
  });

  it("marks the tone on the element so a screen-level test can assert on state, not colour", () => {
    renderBadge(<StatusBadge tone="progress" labelKey="common.status.progress" />);
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-status-tone", "progress");
  });

  it("interpolates label values", () => {
    renderBadge(<StatusBadge tone="info" labelKey="showcase.surfaces.level" labelValues={{ level: 2 }} />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent(
      i18next.t("showcase.surfaces.level", { level: 2 }),
    );
    // A misconfigured interpolation leaks the raw placeholder - the exact failure mode
    // 19_I18N_FR_EN_DE.md §Enforcement item 5 asks to be tested for.
    expect(screen.getByTestId("status-badge").textContent).not.toContain("{{");
  });

  it("refuses to render without a label rather than showing a colour-only badge", () => {
    expect(() => renderBadge(<StatusBadge tone="error" />)).toThrow(/descriptor/);
  });
});
