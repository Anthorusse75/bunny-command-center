// `/guild/:guildId/onboarding` — Step 10's real content
// (IMPLEMENTATION/10_onboarding_approval.md, SCREENS/ONBOARDING.md). A
// single scrollable page with 7 auto-saving, independently-jumpable
// sections — never a forced multi-screen wizard (mission §12). Guild-Admin
// tier only (`RequireGuildAdmin`, already wrapping this route in
// `routes.tsx`).
//
// ** UPDATED — Step 10 external-review Phase 2, Section 12 **: the note
// that used to live here claimed "'Bunny & permissions' is a user
// attestation checkbox, not a live Discord permission check" — that is no
// longer true. The checkbox is gone; see `computeBunnyPermissionsStatus`'s
// doc comment below for the real, live per-channel permission check that
// replaced it (sourced from the SAME channel catalog the pickers below
// already fetch, not a new Discord API client).
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
import { useEffect, useRef, useState } from "react";
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
import { useRealtimeChannel } from "../realtime/index.js";
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

/**
 * Step 10 external-review Phase 2, Section 12 — "Bunny & permissions"
 * becomes a LIVE status/checklist. **FINAL correction, Section 4**: the
 * prior manual attestation checkbox (`{section: "bunnyPermissions", data:
 * {acknowledged}}`) has been removed ENTIRELY — it is no longer accepted by
 * the save API at all (not even for backward compatibility; this branch was
 * unpublished). `bunnyPermissions` remains one of the 7 display/checklist
 * section keys, but it is not user-savable — completion is derived SOLELY
 * from the real, live per-channel permission facts `useOnboardingChannelCatalog`
 * already fetches, at read time, every time — never a stale stored flag a
 * Guild Admin could tick once and then let drift from reality (e.g. after
 * later revoking Bunny's role in Discord). There is exactly one canonical
 * meaning of "bunnyPermissions completed" now: this live computation.
 *
 * Required checks per channel role, verified directly against Bunny's real
 * runtime code (not assumed) before finalizing — Step 10 FINAL external
 * review correction, Section 3: an earlier pass required
 * `canSendMessages` on the Community channel too, which the reviewer
 * correctly flagged as speculative (see the correction below):
 *  - Incoming channel: `canViewChannel` + `canReadHistory` (OCR ingestion
 *    reads message history/attachments there) AND `canSendMessages` — this
 *    third requirement is grounded in `02_NEW_BOT_OCR`'s real
 *    `cogs/y_tasks.py`: the monthly Reminder/Top10-publish messages are
 *    posted to the SAME incoming channel (via
 *    `_approved_guild_channel_pairs`/`get_channel_incoming`), not a
 *    separate channel — a checklist that only checked view+read-history
 *    would show "complete" for a guild where Bunny genuinely cannot post
 *    its monthly publish messages.
 *  - Community channel (optional — only checked if configured):
 *    EXISTENCE ONLY, no permission bit required. **Corrected 2026-08-27**:
 *    a prior pass additionally required `canSendMessages` here, reasoned as
 *    "reasonable UX ahead of a feature shipping" — external review rejected
 *    that as exactly the speculative permission requirement this step's own
 *    rules forbid (`guild_config_selfbot.community_channel_id` is a real
 *    checksummed column, but that is not proof Bunny currently needs
 *    `SEND_MESSAGES` there — Bunny's live code has ZERO real `.send()` call
 *    targeting it today, confirmed by direct inspection). Do not
 *    reintroduce a permission requirement here without citing a real Bunny
 *    consumer.
 *  - Hero channel is intentionally absent from this checklist entirely — it
 *    is a Self-bot-only field (Bunny's channel catalog is merely a
 *    convenient shared channel-id source for its picker); Bunny has no
 *    operational need for any permission there, so it is never presented as
 *    a "Bunny permission" requirement.
 */
export interface BunnyPermissionCheck {
  readonly key: "viewChannel" | "readHistory" | "sendMessages";
  readonly pass: boolean;
}
export interface BunnyPermissionChannelStatus {
  readonly role: "incoming" | "community";
  readonly channelId: string;
  /** `false` if this channel id is no longer present in a fresh catalog fetch (e.g. deleted in Discord since it was configured). */
  readonly found: boolean;
  readonly checks: readonly BunnyPermissionCheck[];
}
export type BunnyPermissionsStatus =
  /** Bunny unreachable/misconfigured/erroring — never fabricate a pass. */
  | { readonly kind: "degraded" }
  | {
      readonly kind: "checked";
      readonly complete: boolean;
      readonly channels: readonly BunnyPermissionChannelStatus[];
    };

export function computeBunnyPermissionsStatus(
  catalog: OnboardingChannelCatalogResponse | undefined,
  catalogLoading: boolean,
  incomingChannelId: string | null,
  communityChannelId: string | null,
): BunnyPermissionsStatus {
  if (catalogLoading || !catalog || !catalog.available) {
    return { kind: "degraded" };
  }
  const channels: BunnyPermissionChannelStatus[] = [];
  if (incomingChannelId !== null) {
    const channel = catalog.channels.find((c) => c.id === incomingChannelId);
    channels.push({
      role: "incoming",
      channelId: incomingChannelId,
      found: channel !== undefined,
      checks: [
        { key: "viewChannel", pass: channel?.canViewChannel ?? false },
        { key: "readHistory", pass: channel?.canReadHistory ?? false },
        { key: "sendMessages", pass: channel?.canSendMessages ?? false },
      ],
    });
  }
  if (communityChannelId !== null) {
    const channel = catalog.channels.find((c) => c.id === communityChannelId);
    // Existence-only (see this function's doc comment) — no permission
    // check for Community, since Bunny has no real current consumer of it.
    channels.push({
      role: "community",
      channelId: communityChannelId,
      found: channel !== undefined,
      checks: [],
    });
  }
  const complete =
    channels.length > 0 && channels.every((c) => c.found && c.checks.every((check) => check.pass));
  return { kind: "checked", complete, channels };
}

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
  // Step 10 external-review correction round, Phase 3 (real bug found while
  // writing the onboarding E2E test): `useState`'s initializer above only
  // ever runs on the FIRST mount, so a Guild Admin who requests activation
  // (or gets rejected) DURING an already-open session — never reloading the
  // page — kept seeing the stepper forever; the marketing Pending/Rejected
  // view only ever appeared on a fresh page load that started already in
  // that state. Tracks the previous lifecycleState and resets `showStepper`
  // to `false` exactly once, only on a genuine transition INTO
  // PENDING_APPROVAL/REJECTED — never on a same-state refetch (which would
  // otherwise fight the user's own "Edit configuration" `setShowStepper(true)`).
  // Live invalidation is generic via `features/onboarding/realtimeWiring.ts`'s
  // `registerQueryInvalidation` — but per `useRealtimeChannel`'s own "STEP
  // 06+ CONSUMER CONTRACT" doc comment, THAT registration only maps
  // eventType -> query keys; it does not by itself make the browser's
  // underlying `EventSource` attach a native listener for this named event
  // type (confirmed by reading `NotificationsScreen.tsx`, the one other real
  // consumer of this exact pattern — it calls this same hook alongside its
  // own `realtimeWiring.ts` registration for exactly this reason). This
  // call's only job is to ensure that listener exists while this screen is
  // mounted; the actual invalidation still happens generically.
  useRealtimeChannel<{ guildId?: string }>("guild_lifecycle.state_changed", () => {});

  const previousLifecycleStateRef = useRef(state.lifecycleState);
  useEffect(() => {
    const previous = previousLifecycleStateRef.current;
    previousLifecycleStateRef.current = state.lifecycleState;
    if (
      previous !== state.lifecycleState &&
      (state.lifecycleState === "PENDING_APPROVAL" || state.lifecycleState === "REJECTED")
    ) {
      setShowStepper(false);
    }
  }, [state.lifecycleState]);

  // Section 12: "bunnyPermissions" completion is now derived live, never
  // read off `state.sections.bunnyPermissions` (which still only reflects
  // whether the now-retired attestation checkbox was ever ticked) — this
  // overridden view is what both the checklist tally below and the
  // sidebar's per-section icon (`ChecklistLayout`) actually use.
  const bunnyPermissionsStatus = computeBunnyPermissionsStatus(
    channelCatalogQuery.data,
    channelCatalogQuery.isPending,
    state.values.incomingChannelId,
    state.values.communityChannelId,
  );
  const bunnyPermissionsComplete =
    bunnyPermissionsStatus.kind === "checked" && bunnyPermissionsStatus.complete;
  const displaySections: OnboardingStateResponse["sections"] = {
    ...state.sections,
    bunnyPermissions: {
      completed: bunnyPermissionsComplete,
      completedAt: state.sections.bunnyPermissions.completedAt,
    },
  };
  const completedCount = ONBOARDING_SECTION_KEYS.filter((key) => displaySections[key].completed).length;

  function announceSaved(): void {
    showToast({ tone: "success", messageKey: "onboarding.toast.sectionSaved" });
  }

  // Step 10 FINAL correction round, Section 6: a channel save rejected by
  // the server (e.g. CHANNEL_PERMISSIONS_MISSING) previously failed
  // silently — the picker just reverted to its last-saved value with no
  // explanation. Every channel section now surfaces the real rejection,
  // same pattern as the Request Activation button's own onError below.
  function announceSaveFailed(err: unknown): void {
    const key = err instanceof ApiError && err.body ? err.body.message_key : "errors.server";
    showToast({ tone: "error", messageKey: key });
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
        sections={displaySections}
        onJump={scrollToSection}
      >
        <Stack spacing={3}>
          <BunnyPermissionsSection status={bunnyPermissionsStatus} />
          <ChannelPickerSection
            sectionKey="incomingChannel"
            value={state.values.incomingChannelId}
            required
            catalog={channelCatalogQuery.data}
            catalogLoading={channelCatalogQuery.isPending}
            onSave={(channelId) => {
              if (!channelId) return Promise.resolve();
              return saveSection
                .mutateAsync({ section: "incomingChannel", data: { channelId } })
                .then(announceSaved, (err: unknown) => {
                  announceSaveFailed(err);
                  throw err;
                });
            }}
          />
          <ChannelPickerSection
            sectionKey="heroChannel"
            value={state.values.heroChannelId}
            required
            catalog={channelCatalogQuery.data}
            catalogLoading={channelCatalogQuery.isPending}
            onSave={(channelId) => {
              if (!channelId) return Promise.resolve();
              return saveSection
                .mutateAsync({ section: "heroChannel", data: { channelId } })
                .then(announceSaved, (err: unknown) => {
                  announceSaveFailed(err);
                  throw err;
                });
            }}
          />
          <ChannelPickerSection
            sectionKey="communityChannel"
            value={state.values.communityChannelId}
            required={false}
            catalog={channelCatalogQuery.data}
            catalogLoading={channelCatalogQuery.isPending}
            onSave={(channelId) => {
              return saveSection
                .mutateAsync({ section: "communityChannel", data: { channelId } })
                .then(announceSaved, (err: unknown) => {
                  announceSaveFailed(err);
                  throw err;
                });
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

function PermissionCheckIcon({ pass }: { pass: boolean }): React.JSX.Element {
  const PassIcon = useBccIcon("check-circle");
  const FailIcon = useBccIcon("alert-octagon");
  return pass ? (
    <PassIcon fontSize="small" color="success" aria-hidden="true" />
  ) : (
    <FailIcon fontSize="small" color="error" aria-hidden="true" />
  );
}

function BunnyPermissionChannelCard({
  channel,
}: {
  channel: BunnyPermissionChannelStatus;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box data-testid={`bunnyPermissions-${channel.role}`}>
      <Typography variant="subtitle2">
        {t(`onboarding.sections.bunnyPermissions.channelRole.${channel.role}`)}
      </Typography>
      {!channel.found ? (
        <Typography role="alert" color="error.main" variant="body2">
          {t("onboarding.sections.bunnyPermissions.channelNotFound")}
        </Typography>
      ) : channel.checks.length === 0 ? (
        // Existence-only channel (Community — see computeBunnyPermissionsStatus's
        // doc comment for why no permission bit applies here).
        <Typography
          variant="body2"
          color="text.secondary"
          data-testid={`bunnyPermissions-${channel.role}-existsOnly`}
        >
          {t("onboarding.sections.bunnyPermissions.existsOnly")}
        </Typography>
      ) : (
        <List dense sx={{ padding: 0 }}>
          {channel.checks.map((check) => (
            <ListItemButton
              key={check.key}
              disableRipple
              disableGutters
              sx={{ paddingBlock: 0, cursor: "default" }}
              data-testid={`bunnyPermissions-check-${channel.role}-${check.key}`}
              data-pass={check.pass}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                <PermissionCheckIcon pass={check.pass} />
              </ListItemIcon>
              <ListItemText primary={t(`onboarding.sections.bunnyPermissions.checks.${check.key}`)} />
            </ListItemButton>
          ))}
        </List>
      )}
    </Box>
  );
}

/**
 * Step 10 external-review Phase 2, Section 12 — see
 * `computeBunnyPermissionsStatus`'s doc comment above for exactly which
 * permissions are checked and why. Never presents a fabricated PASS: a
 * degraded Bunny shows a clearly distinct warning state, never silently
 * reused stale data or an optimistic default.
 */
export function BunnyPermissionsSection({ status }: { status: BunnyPermissionsStatus }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <SectionShell sectionKey="bunnyPermissions">
      <Link href="https://support.discord.com/hc/en-us/articles/206029707" target="_blank" rel="noreferrer">
        {t("onboarding.sections.bunnyPermissions.fixItLink")}
      </Link>
      {status.kind === "degraded" ? (
        <Typography
          role="alert"
          color="warning.main"
          variant="body2"
          sx={{ marginBlockStart: 1 }}
          data-testid="bunnyPermissions-degraded"
        >
          {t("onboarding.sections.bunnyPermissions.degraded")}
        </Typography>
      ) : status.channels.length === 0 ? (
        <Typography color="text.secondary" variant="body2" sx={{ marginBlockStart: 1 }}>
          {t("onboarding.sections.bunnyPermissions.noChannelsConfigured")}
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ marginBlockStart: 1.5 }}>
          {status.channels.map((channel) => (
            <BunnyPermissionChannelCard key={channel.role} channel={channel} />
          ))}
        </Stack>
      )}
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
  // Returns a promise so a REJECTED save (e.g. CHANNEL_PERMISSIONS_MISSING)
  // can revert the optimistic `draft` below back to the last server-
  // confirmed `value` — otherwise the picker would keep showing the
  // rejected selection as if it had saved (Step 10 FINAL correction round,
  // Section 6: proving an under-permissioned Incoming channel is REJECTED
  // requires the picker to visibly not adopt it).
  onSave: (channelId: string | null) => Promise<unknown>;
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
          const previous = value ?? "";
          setDraft(next);
          onSave(next.length > 0 ? next : null).catch(() => {
            setDraft(previous);
          });
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
