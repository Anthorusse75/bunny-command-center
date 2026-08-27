// Step 10 external-review Phase 2, Section 13 — `RolePickerSection`
// (OnboardingScreen.tsx): a real live role dropdown populated from
// `GET /api/guilds/:guildId/onboarding/roles`, replacing the prior
// plain-text-role-ID input. Same isolated-component testing convention as
// `OnboardingChannelPicker.test.tsx` — controlled `catalog`/`catalogLoading`
// props, no react-query/router context needed.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { RolePickerSection } from "../OnboardingScreen.js";

function renderPicker(props: Partial<React.ComponentProps<typeof RolePickerSection>> = {}): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <RolePickerSection
          value={null}
          catalog={undefined}
          catalogLoading={false}
          onSave={vi.fn()}
          {...props}
        />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("RolePickerSection — live Bunny role catalog picker (Phase 2, Section 13)", () => {
  it("disabled/error state: shows the unavailable warning and disables the picker when the catalog is unavailable", () => {
    renderPicker({ catalog: { available: false, roles: [] }, catalogLoading: false });

    expect(screen.getByTestId("adminRolePolicy-catalog-unavailable")).toHaveTextContent(
      i18next.t("onboarding.rolePicker.unavailable"),
    );
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.adminRolePolicy.roleLabel"),
    });
    expect(combobox).toHaveAttribute("aria-disabled", "true");
  });

  it("loading state: does not show the unavailable warning while the catalog query is still pending", () => {
    renderPicker({ catalog: undefined, catalogLoading: true });

    expect(screen.queryByTestId("adminRolePolicy-catalog-unavailable")).not.toBeInTheDocument();
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.adminRolePolicy.roleLabel"),
    });
    expect(combobox).toHaveAttribute("aria-disabled", "true");
  });

  it("available state: no warning shown, the picker is enabled, and real role options (exact Snowflake ids as values) are selectable", async () => {
    const onSave = vi.fn();
    renderPicker({
      catalog: {
        available: true,
        roles: [
          {
            id: "700000000000000001",
            name: "Officers",
            color: 0,
            position: 2,
            managed: false,
            mentionable: true,
            hoist: true,
          },
          {
            id: "700000000000000002",
            name: "Members",
            color: 0,
            position: 1,
            managed: false,
            mentionable: true,
            hoist: false,
          },
        ],
      },
      catalogLoading: false,
      onSave,
    });

    expect(screen.queryByTestId("adminRolePolicy-catalog-unavailable")).not.toBeInTheDocument();
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.adminRolePolicy.roleLabel"),
    });
    expect(combobox).not.toHaveAttribute("aria-disabled", "true");

    const user = userEvent.setup();
    await user.click(combobox);
    const option = await screen.findByRole("option", { name: "@Officers" });
    await user.click(option);

    expect(onSave).toHaveBeenCalledWith("700000000000000001");
  });

  it("selecting the blank option saves null (defaults to Discord Administrator)", async () => {
    const onSave = vi.fn();
    renderPicker({
      value: "700000000000000001",
      catalog: {
        available: true,
        roles: [
          {
            id: "700000000000000001",
            name: "Officers",
            color: 0,
            position: 2,
            managed: false,
            mentionable: true,
            hoist: true,
          },
        ],
      },
      catalogLoading: false,
      onSave,
    });

    const user = userEvent.setup();
    const combobox = screen.getByRole("combobox", {
      name: i18next.t("onboarding.sections.adminRolePolicy.roleLabel"),
    });
    await user.click(combobox);
    const noneOption = await screen.findByRole("option", { name: i18next.t("onboarding.rolePicker.none") });
    await user.click(noneOption);

    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("a previously-selected role no longer present in a fresh catalog is shown as a flagged 'stale' option, never silently kept selected without warning", () => {
    renderPicker({
      value: "700000000000000099",
      catalog: {
        available: true,
        roles: [
          {
            id: "700000000000000001",
            name: "Officers",
            color: 0,
            position: 2,
            managed: false,
            mentionable: true,
            hoist: true,
          },
        ],
      },
      catalogLoading: false,
    });

    expect(
      screen.getByText(i18next.t("onboarding.rolePicker.staleValue", { roleId: "700000000000000099" })),
    ).toBeInTheDocument();
  });
});
