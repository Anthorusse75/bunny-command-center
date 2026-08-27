// `/guild/:guildId/onboarding` — Step 10's real content
// (IMPLEMENTATION/10_onboarding_approval.md, SCREENS/ONBOARDING.md). A
// single scrollable page with 7 auto-saving, independently-jumpable
// sections — never a forced multi-screen wizard (mission §12). Guild-Admin
// tier only (`RequireGuildAdmin`, already wrapping this route in
// `routes.tsx`).
//
// ** Disclosed scope note ** (00_GLOBAL_IMPLEMENTATION_RULES.md rule 1):
// "Bunny & permissions" is a user attestation checkbox, not a live Discord
// permission check (no bot-token Discord API client exists anywhere in this
// codebase — `packages/shared/src/types/lifecycle.ts`'s own comment on
// `onboardingSectionSaveSchema` has the full rationale).
//
// Step 10 correction round, Gap 2: the three channel fields (Incoming/Hero/
// Community) now use a real live dropdown (`ChannelPickerSection`) populated
// from `GET /api/guilds/:guildId/onboarding/channels`, which proxies Bunny's
// real channel catalog — replacing the prior plain-text-snowflake-input
// placeholder.
//
// Step 10 external-review Phase 2, Section 13: `adminRolePolicy` (a Discord
// ROLE id, not a channel) now uses the same live-dropdown treatment
// (`RolePickerSection`, populated from `GET
// /api/guilds/:guildId/onboarding/roles`, proxying Bunny's real,
// already-merged role catalog — Step 08 Workstream E, `origin/V2.0`). The
// prior comment here claiming "no role-catalog endpoint exists yet" was
// stale/incorrect by the time this correction round started — the endpoint
// had already shipped, just never consumed by this screen.
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTranslation } from "react-i18next";
import type {
  OnboardingChannelCatalogResponse,
  OnboardingRoleCatalogResponse,
  OnboardingSectionKey,
  OnboardingStateResponse,
} from "@bunny-command-center/shared";
import { ONBOARDING_SECTION_KEYS } from "@bunny-command-center/shared";
import { useGuildOverviewContext } from "../navigation/GuildRouteGuard.js";
import { PageHeading } from "../navigation/PageHeading.js";
import { useToast } from "../design-system/ToastProvider.js";
import { useBccIcon } from "../design-system/icons.js";
import { ApiError } from "../features/auth/index.js";
import {
  useGuildLifecycleActionMutation,
  useOnboardingChannelCatalog,
  useOnboardingRoleCatalog,
  useOnboardingState,
  useRequestActivationMutation,
  useSaveOnboardingSectionMutation,
} from "../features/onboarding/index.js";

export function OnboardingScreen(): React.JSX.Element {
  const overview = useGuildOverviewContext();
  const { t } = useTranslation();
  const query = useOnboardingState(overview.guildId);

  const title = overview.displayName
    ? t("onboarding.title", { guildName: overview.displayName })
    : t("onboarding.titleFallback");

  if (query.isPending) {
    return (
      <Box sx={{ maxWidth: 960 }}>
        <PageHeading text={title} />
        <Box role="status" aria-live="polite" sx={{ display: "flex", justifyContent: "center", padding: 6 }}>
          <CircularProgress aria-label={t("common.state.loading")} />
        </Box>
      </Box>
    );
  }

  if (query.error) {
    return (
      <Box sx={{ maxWidth: 960 }}>
        <PageHeading text={title} />
        <Typography role="alert" color="error.main">
          {t("errors.server")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 960 }}>
      <PageHeading text={title} />
      <OnboardingContent guildId={overview.guildId} state={query.data} />
    </Box>
  );
}

const SECTION_TITLE_KEY: Record<OnboardingSectionKey, string> = {
  bunnyPermissions: "onboarding.sections.bunnyPermissions.title",
  incomingChannel: "onboarding.sections.incomingChannel.title",
  heroChannel: "onboarding.sections.heroChannel.title",
  communityChannel: "onboarding.sections.communityChannel.title",
  seasonQuotas: "onboarding.sections.seasonQuotas.title",
  notifications: "onboarding.sections.notifications.title",
  adminRolePolicy: "onboarding.sections.adminRolePolicy.title",
};

function OnboardingContent({
  guildId,
  state,
}: {
  guildId: string;
  state: OnboardingStateResponse;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const saveSection = useSaveOnboardingSectionMutation(guildId);
  const requestActivationMutation = useRequestActivationMutation(guildId);
  const lifecycleAction = useGuildLifecycleActionMutation(guildId);
  const channelCatalogQuery = useOnboardingChannelCatalog(guildId);
  const roleCatalogQuery = useOnboardingRoleCatalog(guildId);
  // PENDING_APPROVAL/REJECTED default to their marketing/reason view
  // (SCREENS/ONBOARDING.md: "never looks like a 403" / "never a dead end")
  // rather than the stepper — both offer an explicit CTA to reveal it.
  const [showStepper, setShowStepper] = useState(
    state.lifecycleState !== "PENDING_APPROVAL" && state.lifecycleState !== "REJECTED",
  );

  const completedCount = ONBOARDING_SECTION_KEYS.filter((key) => state.sections[key].completed).length;

  function announceSaved(): void {
    showToast({ tone: "success", messageKey: "onboarding.toast.sectionSaved" });
  }

  function scrollToSection(key: OnboardingSectionKey): void {
    document
      .getElementById(`onboarding-section-${key}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (state.lifecycleState === "PLATFORM_SUSPENDED") {
    return (
      <Paper sx={{ padding: 3 }} role="status">
        <Typography variant="h5" component="h2" sx={{ marginBlockEnd: 1 }}>
          {t("onboarding.suspended.title")}
        </Typography>
        <Typography color="text.secondary">{t("onboarding.suspended.body")}</Typography>
      </Paper>
    );
  }

  if (state.lifecycleState === "PENDING_APPROVAL" && !showStepper) {
    return <PendingView onEditConfiguration={() => setShowStepper(true)} />;
  }

  if (state.lifecycleState === "REJECTED" && !showStepper) {
    return (
      <RejectedView
        reason={state.latestRequest?.decisionReason ?? null}
        pending={lifecycleAction.isPending}
        onEditAndResubmit={() => {
          lifecycleAction.mutate("reopen", { onSuccess: () => setShowStepper(true) });
        }}
      />
    );
  }

  return (
    <Stack spacing={3}>
      {state.lifecycleState === "CHANGES_REQUESTED" ? (
        <ReasonBanner
          titleKey="onboarding.changesRequested.title"
          reason={state.latestRequest?.decisionReason ?? null}
        />
      ) : null}
      {state.lifecycleState === "ACTIVE" ? (
        <LifecycleActionBanner
          labelKey="onboarding.actions.pause"
          onClick={() => lifecycleAction.mutate("pause")}
          pending={lifecycleAction.isPending}
        />
      ) : null}
      {state.lifecycleState === "USER_PAUSED" ? (
        <LifecycleActionBanner
          titleKey="onboarding.activePaused.title"
          bodyKey="onboarding.activePaused.body"
          labelKey="onboarding.actions.resume"
          onClick={() => lifecycleAction.mutate("resume")}
          pending={lifecycleAction.isPending}
        />
      ) : null}

      <ChecklistLayout
        completedCount={completedCount}
        totalCount={ONBOARDING_SECTION_KEYS.length}
        sections={state.sections}
        onJump={scrollToSection}
      >
        <Stack spacing={3}>
          <BunnyPermissionsSection
            acknowledged={state.values.bunnyPermissionsAcknowledged}
            onSave={(acknowledged) => {
              saveSection.mutate(
                { section: "bunnyPermissions", data: { acknowledged } },
                { onSuccess: announceSaved },
              );
            }}
          />
          <ChannelPickerSection
            sectionKey="incomingChannel"
            value={state.values.incomingChannelId}
            required
            catalog={channelCatalogQuery.data}
            catalogLoading={channelCatalogQuery.isPending}
            onSave={(channelId) => {
              if (!channelId) return;
              saveSection.mutate(
                { section: "incomingChannel", data: { channelId } },
                { onSuccess: announceSaved },
              );
            }}
          />
          <ChannelPickerSection
            sectionKey="heroChannel"
            value={state.values.heroChannelId}
            required
            catalog={channelCatalogQuery.data}
            catalogLoading={channelCatalogQuery.isPending}
            onSave={(channelId) => {
              if (!channelId) return;
              saveSection.mutate(
                { section: "heroChannel", data: { channelId } },
                { onSuccess: announceSaved },
              );
            }}
          />
          <ChannelPickerSection
            sectionKey="communityChannel"
            value={state.values.communityChannelId}
            required={false}
            catalog={channelCatalogQuery.data}
            catalogLoading={channelCatalogQuery.isPending}
            onSave={(channelId) => {
              saveSection.mutate(
                { section: "communityChannel", data: { channelId } },
                { onSuccess: announceSaved },
              );
            }}
          />
          <SeasonQuotasSection
            acceptPlatformDefaults={state.values.seasonQuotaAcceptPlatformDefaults}
            quotaOverrides={state.values.seasonQuotaOverrides}
            onSave={(acceptPlatformDefaults, quotaOverrides) => {
              saveSection.mutate(
                { section: "seasonQuotas", data: { acceptPlatformDefaults, quotaOverrides } },
                { onSuccess: announceSaved },
              );
            }}
          />
          <NotificationsSection
            inAppEnabled={state.values.notificationsInAppEnabled}
            discordDmEnabled={state.values.notificationsDiscordDmEnabled}
            onSave={(inAppEnabled, discordDmEnabled) => {
              saveSection.mutate(
                { section: "notifications", data: { inAppEnabled, discordDmEnabled } },
                { onSuccess: announceSaved },
              );
            }}
          />
          <RolePickerSection
            value={state.values.adminRoleDiscordId}
            catalog={roleCatalogQuery.data}
            catalogLoading={roleCatalogQuery.isPending}
            onSave={(adminRoleDiscordId) => {
              saveSection.mutate(
                { section: "adminRolePolicy", data: { adminRoleDiscordId } },
                { onSuccess: announceSaved },
              );
            }}
          />
        </Stack>
      </ChecklistLayout>

      <RequestActivationBar
        lifecycleState={state.lifecycleState}
        minimumChecklistPassed={state.minimumChecklistPassed}
        pending={requestActivationMutation.isPending}
        onRequestActivation={() => {
          requestActivationMutation.mutate(undefined, {
            onSuccess: () =>
              showToast({ tone: "success", messageKey: "onboarding.toast.activationRequested" }),
            onError: (err) => {
              const key = err instanceof ApiError && err.body ? err.body.message_key : "errors.server";
              showToast({ tone: "error", messageKey: key });
            },
          });
        }}
      />
    </Stack>
  );
}

function ChecklistLayout({
  completedCount,
  totalCount,
  sections,
  onJump,
  children,
}: {
  completedCount: number;
  totalCount: number;
  sections: OnboardingStateResponse["sections"];
  onJump: (key: OnboardingSectionKey) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const { t } = useTranslation();

  const checklist = (
    <nav aria-label={t("onboarding.checklist.heading")}>
      <Typography variant="subtitle2" sx={{ marginBlockEnd: 1 }}>
        {t("onboarding.checklist.sectionsComplete", { completed: completedCount, total: totalCount })}
      </Typography>
      <List dense sx={{ padding: 0 }}>
        {ONBOARDING_SECTION_KEYS.map((key) => (
          <ListItemButton key={key} onClick={() => onJump(key)} sx={{ borderRadius: 1 }}>
            <ListItemIcon sx={{ minWidth: 32 }} aria-hidden="true">
              <SectionCompletionIcon completed={sections[key].completed} />
            </ListItemIcon>
            <ListItemText
              primary={t(SECTION_TITLE_KEY[key])}
              secondary={sections[key].completed ? undefined : undefined}
            />
          </ListItemButton>
        ))}
      </List>
    </nav>
  );

  if (isDesktop) {
    return (
      <Box sx={{ display: "flex", gap: 3, alignItems: "flex-start" }}>
        <Paper sx={{ padding: 2, position: "sticky", top: 16, width: 260, flexShrink: 0 }}>{checklist}</Paper>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>{children}</Box>
      </Box>
    );
  }

  return (
    <Stack spacing={2}>
      <Paper sx={{ padding: 2 }}>{checklist}</Paper>
      {children}
    </Stack>
  );
}

function SectionCompletionIcon({ completed }: { completed: boolean }): React.JSX.Element {
  const CheckIcon = useBccIcon("check-circle");
  const CircleIcon = useBccIcon("circle-dot");
  return completed ? (
    <CheckIcon fontSize="small" color="success" />
  ) : (
    <CircleIcon fontSize="small" color="disabled" />
  );
}

function SectionShell({
  sectionKey,
  children,
}: {
  sectionKey: OnboardingSectionKey;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper
      id={`onboarding-section-${sectionKey}`}
      sx={{ padding: 3, scrollMarginTop: 16 }}
      component="section"
    >
      <Typography variant="h6" component="h2" sx={{ marginBlockEnd: 0.5 }}>
        {t(SECTION_TITLE_KEY[sectionKey])}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ marginBlockEnd: 2 }}>
        {t(`onboarding.sections.${sectionKey}.description`)}
      </Typography>
      {children}
    </Paper>
  );
}

function BunnyPermissionsSection({
  acknowledged,
  onSave,
}: {
  acknowledged: boolean;
  onSave: (acknowledged: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <SectionShell sectionKey="bunnyPermissions">
      <Link href="https://support.discord.com/hc/en-us/articles/206029707" target="_blank" rel="noreferrer">
        {t("onboarding.sections.bunnyPermissions.fixItLink")}
      </Link>
      <FormControlLabel
        sx={{ display: "block", marginBlockStart: 1 }}
        control={<Checkbox checked={acknowledged} onChange={(e) => onSave(e.target.checked)} />}
        label={t("onboarding.sections.bunnyPermissions.acknowledge")}
      />
    </SectionShell>
  );
}

/**
 * Step 10 correction round, Gap 2 — a real live channel dropdown (MUI's
 * `TextField select`, the SAME form-control family already used everywhere
 * else on this screen — no new component pattern introduced) populated from
 * `GET /api/guilds/:guildId/onboarding/channels` (proxying Bunny's real
 * catalog). Degrades gracefully to a DISABLED picker with an inline warning
 * when the catalog is unavailable (Bunny unreachable/erroring/misconfigured)
 * — this never blocks the rest of the onboarding page (every other section
 * is an independent component with its own save path).
 */
export function ChannelPickerSection({
  sectionKey,
  value,
  required,
  catalog,
  catalogLoading,
  onSave,
}: {
  sectionKey: OnboardingSectionKey;
  value: string | null;
  required: boolean;
  catalog: OnboardingChannelCatalogResponse | undefined;
  catalogLoading: boolean;
  onSave: (channelId: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value ?? "");

  // Keeps the picker in sync if the server-confirmed value changes out from
  // under it (e.g. a save from another tab, or the initial query resolving
  // after this component already mounted with `value: null`).
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const available = catalog?.available ?? false;
  const channels = catalog?.channels ?? [];
  const disabled = catalogLoading || !available;

  // The currently-saved value might no longer be present in a fresh catalog
  // fetch (the channel was deleted, or the catalog is a different guild's
  // stale cache) — shown as its own selectable-but-flagged entry rather than
  // silently vanishing or triggering an MUI "out of range value" warning.
  const showStaleValueOption = value !== null && !channels.some((c) => c.id === value);

  return (
    <SectionShell sectionKey={sectionKey}>
      {!catalogLoading && !available ? (
        <Typography
          role="alert"
          color="warning.main"
          variant="body2"
          sx={{ marginBlockEnd: 1 }}
          data-testid={`${sectionKey}-catalog-unavailable`}
        >
          {t("onboarding.channelPicker.unavailable")}
        </Typography>
      ) : null}
      <TextField
        select
        fullWidth
        size="small"
        label={t(`onboarding.sections.${sectionKey}.channelIdLabel`)}
        value={draft}
        disabled={disabled}
        data-testid={`${sectionKey}-picker`}
        helperText={disabled && !catalogLoading ? t("onboarding.channelPicker.unavailableHint") : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          onSave(next.length > 0 ? next : null);
        }}
      >
        {!required ? (
          <MenuItem value="">{t("onboarding.channelPicker.none")}</MenuItem>
        ) : (
          <MenuItem value="" disabled>
            {t("onboarding.channelPicker.placeholder")}
          </MenuItem>
        )}
        {showStaleValueOption && value !== null ? (
          <MenuItem value={value}>{t("onboarding.channelPicker.staleValue", { channelId: value })}</MenuItem>
        ) : null}
        {channels.map((channel) => (
          <MenuItem key={channel.id} value={channel.id}>
            {`#${channel.name}`}
          </MenuItem>
        ))}
      </TextField>
    </SectionShell>
  );
}

/**
 * Step 10 external-review Phase 2, Section 13 — the Admin Role Policy
 * section's real dropdown (MUI's `TextField select`, the same form-control
 * family `ChannelPickerSection` already uses), populated from `GET
 * /api/guilds/:guildId/onboarding/roles` (proxying Bunny's real,
 * already-merged role catalog). Optional, unlike the channel pickers — a
 * blank selection defaults to Discord's raw ADMINISTRATOR permission bit
 * (see the section's own description). Degrades the same way
 * `ChannelPickerSection` does: a DISABLED picker with an inline warning
 * when Bunny is unreachable, never blocking the rest of onboarding.
 */
export function RolePickerSection({
  value,
  catalog,
  catalogLoading,
  onSave,
}: {
  value: string | null;
  catalog: OnboardingRoleCatalogResponse | undefined;
  catalogLoading: boolean;
  onSave: (roleId: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const available = catalog?.available ?? false;
  const roles = catalog?.roles ?? [];
  const disabled = catalogLoading || !available;

  // The currently-saved role might no longer exist in a fresh catalog fetch
  // (the role was deleted) — shown as its own selectable-but-flagged entry,
  // per this codebase's established convention for a stale channel-picker
  // value, rather than silently keeping a deleted role selected with no
  // visible warning.
  const showStaleValueOption = value !== null && !roles.some((r) => r.id === value);

  return (
    <SectionShell sectionKey="adminRolePolicy">
      {!catalogLoading && !available ? (
        <Typography
          role="alert"
          color="warning.main"
          variant="body2"
          sx={{ marginBlockEnd: 1 }}
          data-testid="adminRolePolicy-catalog-unavailable"
        >
          {t("onboarding.rolePicker.unavailable")}
        </Typography>
      ) : null}
      <TextField
        select
        fullWidth
        size="small"
        label={t("onboarding.sections.adminRolePolicy.roleLabel")}
        value={draft}
        disabled={disabled}
        data-testid="adminRolePolicy-picker"
        helperText={disabled && !catalogLoading ? t("onboarding.rolePicker.unavailableHint") : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          onSave(next.length > 0 ? next : null);
        }}
      >
        <MenuItem value="">{t("onboarding.rolePicker.none")}</MenuItem>
        {showStaleValueOption && value !== null ? (
          <MenuItem value={value}>{t("onboarding.rolePicker.staleValue", { roleId: value })}</MenuItem>
        ) : null}
        {roles.map((role) => (
          <MenuItem key={role.id} value={role.id}>
            {`@${role.name}`}
          </MenuItem>
        ))}
      </TextField>
    </SectionShell>
  );
}

/**
 * Step 10 external-review correction round, Section 9: minimal MECHANICAL
 * adaptation to the real 5-numeric-value quota model (replacing the fake
 * category-string model this component previously drove) — kept
 * deliberately rough/unstyled; a proper redesigned UI for this section is
 * Phase 2's job, not this backend-focused correction round's. This exists
 * only so the monorepo keeps compiling and the section remains genuinely
 * functional (every override key settable) under the new wire contract.
 */
const QUOTA_OVERRIDE_KEYS = ["gcHero", "gcTitan", "hol", "hero", "titan"] as const;
type QuotaOverrides = OnboardingStateResponse["values"]["seasonQuotaOverrides"];

function SeasonQuotasSection({
  acceptPlatformDefaults,
  quotaOverrides,
  onSave,
}: {
  acceptPlatformDefaults: boolean;
  quotaOverrides: QuotaOverrides;
  onSave: (acceptPlatformDefaults: boolean, quotaOverrides: QuotaOverrides) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [acceptDefaults, setAcceptDefaults] = useState(acceptPlatformDefaults);
  const [overrides, setOverrides] = useState<QuotaOverrides>(quotaOverrides);

  function commit(nextAcceptDefaults: boolean, nextOverrides: QuotaOverrides): void {
    onSave(nextAcceptDefaults, nextOverrides);
  }

  return (
    <SectionShell sectionKey="seasonQuotas">
      <FormControlLabel
        control={
          <Checkbox
            checked={acceptDefaults}
            onChange={(e) => {
              setAcceptDefaults(e.target.checked);
              commit(e.target.checked, overrides);
            }}
          />
        }
        label={t("onboarding.sections.seasonQuotas.acceptDefaults")}
      />
      {!acceptDefaults
        ? QUOTA_OVERRIDE_KEYS.map((key) => (
            <TextField
              key={key}
              fullWidth
              size="small"
              type="number"
              sx={{ marginBlockStart: 1 }}
              label={key}
              value={overrides[key] ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                const next: QuotaOverrides = { ...overrides };
                if (raw === "") {
                  delete next[key];
                } else {
                  const parsed = Number.parseInt(raw, 10);
                  if (Number.isFinite(parsed) && parsed >= 0) {
                    next[key] = parsed;
                  }
                }
                setOverrides(next);
              }}
              onBlur={() => commit(acceptDefaults, overrides)}
            />
          ))
        : null}
    </SectionShell>
  );
}

function NotificationsSection({
  inAppEnabled,
  discordDmEnabled,
  onSave,
}: {
  inAppEnabled: boolean | null;
  discordDmEnabled: boolean | null;
  onSave: (inAppEnabled: boolean, discordDmEnabled: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [inApp, setInApp] = useState(inAppEnabled ?? true);
  const [discordDm, setDiscordDm] = useState(discordDmEnabled ?? true);

  return (
    <SectionShell sectionKey="notifications">
      <FormControlLabel
        sx={{ display: "block" }}
        control={
          <Checkbox
            checked={inApp}
            onChange={(e) => {
              setInApp(e.target.checked);
              onSave(e.target.checked, discordDm);
            }}
          />
        }
        label={t("onboarding.sections.notifications.inApp")}
      />
      <FormControlLabel
        sx={{ display: "block" }}
        control={
          <Checkbox
            checked={discordDm}
            onChange={(e) => {
              setDiscordDm(e.target.checked);
              onSave(inApp, e.target.checked);
            }}
          />
        }
        label={t("onboarding.sections.notifications.discordDm")}
      />
    </SectionShell>
  );
}

function RequestActivationBar({
  lifecycleState,
  minimumChecklistPassed,
  pending,
  onRequestActivation,
}: {
  lifecycleState: OnboardingStateResponse["lifecycleState"];
  minimumChecklistPassed: boolean;
  pending: boolean;
  onRequestActivation: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const isPendingApproval = lifecycleState === "PENDING_APPROVAL";
  const canRequest =
    (lifecycleState === "CONFIGURING" || lifecycleState === "CHANGES_REQUESTED") && minimumChecklistPassed;

  if (lifecycleState === "ACTIVE" || lifecycleState === "USER_PAUSED") {
    return null;
  }

  return (
    <Paper sx={{ padding: 2, display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
      <Button
        variant="contained"
        disabled={isPendingApproval || !canRequest || pending}
        onClick={onRequestActivation}
      >
        {isPendingApproval
          ? t("onboarding.actions.requestActivationPending")
          : t("onboarding.actions.requestActivation")}
      </Button>
      {!canRequest && !isPendingApproval ? (
        <Typography variant="body2" color="text.secondary">
          {t("onboarding.actions.requestActivationDisabledHint")}
        </Typography>
      ) : null}
    </Paper>
  );
}

function PendingView({ onEditConfiguration }: { onEditConfiguration: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const unlocks = [
    "bulkUpload",
    "ocr",
    "statistics",
    "premiumPlus",
    "stockAcrossSeasons",
    "automation",
    "leaderboards",
    "notifications",
    "forecasts",
    "historyAndBadges",
  ] as const;
  return (
    <Paper sx={{ padding: 3 }} role="status">
      <Typography variant="h5" component="h2" sx={{ marginBlockEnd: 1 }}>
        {t("onboarding.pending.title")}
      </Typography>
      <Typography sx={{ marginBlockEnd: 1 }}>{t("onboarding.pending.body")}</Typography>
      <List dense>
        {unlocks.map((key) => (
          <ListItemText key={key} primary={`• ${t(`onboarding.pending.unlocks.${key}`)}`} />
        ))}
      </List>
      <Button variant="outlined" onClick={onEditConfiguration} sx={{ marginBlockStart: 2 }}>
        {t("onboarding.pending.editConfiguration")}
      </Button>
    </Paper>
  );
}

function RejectedView({
  reason,
  pending,
  onEditAndResubmit,
}: {
  reason: string | null;
  pending: boolean;
  onEditAndResubmit: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper sx={{ padding: 3 }} role="status">
      <Typography variant="h5" component="h2" sx={{ marginBlockEnd: 1 }}>
        {t("onboarding.rejected.title")}
      </Typography>
      {reason ? (
        <Typography sx={{ marginBlockEnd: 2 }}>
          <strong>{t("onboarding.rejected.reasonLabel")}:</strong> {reason}
        </Typography>
      ) : null}
      <Button variant="contained" disabled={pending} onClick={onEditAndResubmit}>
        {t("onboarding.actions.editAndResubmit")}
      </Button>
    </Paper>
  );
}

function ReasonBanner({ titleKey, reason }: { titleKey: string; reason: string | null }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper sx={{ padding: 2 }} role="status">
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {t(titleKey)}
      </Typography>
      {reason ? (
        <Typography variant="body2">
          <strong>{t("onboarding.changesRequested.reasonLabel")}:</strong> {reason}
        </Typography>
      ) : null}
    </Paper>
  );
}

function LifecycleActionBanner({
  titleKey,
  bodyKey,
  labelKey,
  onClick,
  pending,
}: {
  titleKey?: string;
  bodyKey?: string;
  labelKey: string;
  onClick: () => void;
  pending: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper
      sx={{ padding: 2, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2 }}
    >
      <Box>
        {titleKey ? (
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {t(titleKey)}
          </Typography>
        ) : null}
        {bodyKey ? (
          <Typography variant="body2" color="text.secondary">
            {t(bodyKey)}
          </Typography>
        ) : null}
      </Box>
      <Button variant="outlined" disabled={pending} onClick={onClick}>
        {t(labelKey)}
      </Button>
    </Paper>
  );
}
