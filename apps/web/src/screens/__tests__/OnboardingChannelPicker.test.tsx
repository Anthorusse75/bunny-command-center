// Step 10 correction round, Gap 2 — web unit test for `ChannelPickerSection`
// (OnboardingScreen.tsx): a real live channel dropdown populated from
// `GET /api/guilds/:guildId/onboarding/channels`. This test exercises the
// component directly with controlled `catalog`/`catalogLoading` props
// (the shape `useOnboardingChannelCatalog` resolves to) rather than mounting
// the full screen — it needs no react-query/router context, only i18n/theme,
// matching this repo's convention of testing a focused unit in isolation
// when the parent screen's own data-fetching isn't what's under test.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { ChannelPickerSection } from "../OnboardingScreen.js";

function renderPicker(props: Partial<React.ComponentProps<typeof ChannelPickerSection>> = {}): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <ChannelPickerSection
          sectionKey="incomingChannel"
          value={null}
          required
          catalog={undefined}
          catalogLoading={false}
          onSave={vi.fn().mockResolvedValue(undefined)}
          {...props}
        />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("ChannelPickerSection — live Bunny channel catalog picker (Gap 2)", () => {
  it("disabled/error state: shows the unavailable warning and disables the picker when the catalog is unavailable", () => {
    renderPicker({ catalog: { available: false, channels: [] }, catalogLoading: false });

    expect(screen.getByTestId("incomingChannel-catalog-unavailable")).toHaveTextContent(
      i18next.t("onboarding.channelPicker.unavailable"),
    );
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.incomingChannel.channelIdLabel"),
    });
    expect(combobox).toHaveAttribute("aria-disabled", "true");
  });

  it("loading state: does not show the unavailable warning while the catalog query is still pending", () => {
    renderPicker({ catalog: undefined, catalogLoading: true });

    expect(screen.queryByTestId("incomingChannel-catalog-unavailable")).not.toBeInTheDocument();
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.incomingChannel.channelIdLabel"),
    });
    expect(combobox).toHaveAttribute("aria-disabled", "true");
  });

  it("available state: no warning shown, the picker is enabled, and real channel options are selectable", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderPicker({
      catalog: {
        available: true,
        channels: [
          {
            id: "500000000000000001",
            name: "incoming-screenshots",
            position: 0,
            type: "text",
            canReadHistory: true,
            canViewChannel: true,
            canSendMessages: true,
          },
          {
            id: "500000000000000002",
            name: "other-channel",
            position: 1,
            type: "text",
            canReadHistory: true,
            canViewChannel: true,
            canSendMessages: true,
          },
        ],
      },
      catalogLoading: false,
      onSave,
    });

    expect(screen.queryByTestId("incomingChannel-catalog-unavailable")).not.toBeInTheDocument();
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.incomingChannel.channelIdLabel"),
    });
    expect(combobox).not.toHaveAttribute("aria-disabled", "true");

    const user = userEvent.setup();
    await user.click(combobox);
    const option = await screen.findByRole("option", { name: "#incoming-screenshots" });
    await user.click(option);

    expect(onSave).toHaveBeenCalledWith("500000000000000001");
  });

  it("a saved value no longer present in a fresh catalog is shown as a flagged 'stale' option, never silently dropped", () => {
    renderPicker({
      value: "500000000000000099",
      catalog: {
        available: true,
        channels: [
          {
            id: "500000000000000001",
            name: "incoming-screenshots",
            position: 0,
            type: "text",
            canReadHistory: true,
            canViewChannel: true,
            canSendMessages: true,
          },
        ],
      },
      catalogLoading: false,
    });

    expect(
      screen.getByText(i18next.t("onboarding.channelPicker.staleValue", { channelId: "500000000000000099" })),
    ).toBeInTheDocument();
  });
});
