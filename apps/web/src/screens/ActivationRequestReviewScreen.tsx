// `/admin/platform/guilds/:guildId/review/:requestId` — Superadmin-only
// (see SuperadminRouteGuard.tsx). Step 10 external-review Phase 2, Section
// 3: the deep-link `activationRequestsService.ts:102` already generates was
// previously a dead end (no matching route).
//
// ** Explicit scope boundary ** (orchestrator instruction, verbatim): this
// is NOT Step 11's full console. No pending-guilds list, no filters, no
// bulk actions. Exactly one request, identified by the URL's `:requestId`,
// reviewable and actionable. Nothing more.
import { useState } from "react";
import { useParams } from "react-router";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import type {
  ActivationDecisionResponse,
  ActivationRequestDetailResponse,
} from "@bunny-command-center/shared";
import { PageHeading } from "../navigation/PageHeading.js";
import { useToast } from "../design-system/ToastProvider.js";
import { ApiError } from "../features/auth/index.js";
import {
  useActivationRequestDetail,
  useApproveActivationRequestMutation,
  useRejectActivationRequestMutation,
  useRequestChangesOnActivationRequestMutation,
} from "../features/activationReview/index.js";

const REASON_MAX_LENGTH = 2000;

function apiErrorMessageKey(err: unknown): string {
  return err instanceof ApiError && err.body ? err.body.message_key : "errors.server";
}

export function ActivationRequestReviewScreen(): React.JSX.Element {
  const { guildId, requestId } = useParams<{ guildId: string; requestId: string }>();
  const { t } = useTranslation();
  const title = t("superadmin.review.title");

  // Route params are always present given how this route is registered
  // (routes.tsx: both are required path segments) — this guard exists only
  // so TypeScript's `useParams` optionality doesn't leak further down, never
  // an expected runtime state.
  if (!guildId || !requestId) {
    return (
      <Box sx={{ maxWidth: 720 }}>
        <PageHeading text={title} />
        <Typography role="alert" color="error.main">
          {t("errors.notFound")}
        </Typography>
      </Box>
    );
  }

  return <ActivationRequestReviewContent guildId={guildId} requestId={requestId} />;
}

function ActivationRequestReviewContent({
  guildId,
  requestId,
}: {
  guildId: string;
  requestId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const title = t("superadmin.review.title");
  const query = useActivationRequestDetail(requestId);

  if (query.isPending) {
    return (
      <Box sx={{ maxWidth: 720 }}>
        <PageHeading text={title} />
        <Box role="status" aria-live="polite" sx={{ display: "flex", justifyContent: "center", padding: 6 }}>
          <CircularProgress aria-label={t("common.state.loading")} />
        </Box>
      </Box>
    );
  }

  if (query.error) {
    return (
      <Box sx={{ maxWidth: 720 }}>
        <PageHeading text={title} />
        <Typography role="alert" color="error.main">
          {t(apiErrorMessageKey(query.error))}
        </Typography>
      </Box>
    );
  }

  const detail = query.data;

  // The route's own :guildId param is NOT trusted as authoritative — the
  // server's response is (explicit orchestrator requirement). A mismatch
  // (e.g. a stale/tampered link, or a requestId that legitimately belongs to
  // a different guild) must show an error state, never silently proceed as
  // if the URL's guildId were correct.
  if (detail.guildId !== guildId) {
    return (
      <Box sx={{ maxWidth: 720 }}>
        <PageHeading text={title} />
        <Typography role="alert" color="error.main" data-testid="guild-mismatch-error">
          {t("superadmin.review.guildMismatch")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 720 }}>
      <PageHeading text={title} />
      <Stack spacing={3}>
        <RequestMetadataCard detail={detail} />
        {detail.state === "PENDING" || detail.state === "CHANGES_REQUESTED" ? (
          <>
            <FrozenSnapshotCard detail={detail} />
            <LiveScopeNoteCard />
            <DecisionActions requestId={requestId} />
          </>
        ) : (
          <AlreadyDecidedCard detail={detail} />
        )}
      </Stack>
    </Box>
  );
}

function RequestMetadataCard({ detail }: { detail: ActivationRequestDetailResponse }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper sx={{ padding: 3 }} component="section">
      <Typography variant="h6" component="h2" sx={{ marginBlockEnd: 1 }}>
        {t("superadmin.review.metadata.title")}
      </Typography>
      <Stack spacing={0.5}>
        <Typography variant="body2">
          <strong>{t("superadmin.review.metadata.guildId")}:</strong> {detail.guildId}
        </Typography>
        <Typography variant="body2">
          <strong>{t("superadmin.review.metadata.state")}:</strong>{" "}
          {t(`superadmin.review.state.${detail.state}`)}
        </Typography>
        <Typography variant="body2">
          <strong>{t("superadmin.review.metadata.requestedBy")}:</strong> {detail.requestedBy}
        </Typography>
        <Typography variant="body2">
          <strong>{t("superadmin.review.metadata.requestedAt")}:</strong>{" "}
          {new Date(detail.requestedAt).toLocaleString()}
        </Typography>
      </Stack>
    </Paper>
  );
}

/** The frozen/versioned portion — see getMaterializedConfigSnapshot's doc comment (apps/api) for exactly what is and is not included. */
function FrozenSnapshotCard({ detail }: { detail: ActivationRequestDetailResponse }): React.JSX.Element {
  const { t } = useTranslation();
  const snapshot = detail.configSnapshot;
  return (
    <Paper sx={{ padding: 3 }} component="section">
      <Typography variant="h6" component="h2" sx={{ marginBlockEnd: 0.5 }}>
        {t("superadmin.review.snapshot.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ marginBlockEnd: 2 }}>
        {t("superadmin.review.snapshot.description")}
      </Typography>
      {snapshot === null ? (
        <Typography role="alert" color="error.main">
          {t("superadmin.review.snapshot.unavailable")}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          <Typography variant="body2">
            <strong>{t("onboarding.sections.incomingChannel.title")}:</strong>{" "}
            {snapshot.incomingChannelId ?? t("superadmin.review.snapshot.notSet")}
          </Typography>
          <Typography variant="body2">
            <strong>{t("onboarding.sections.heroChannel.title")}:</strong>{" "}
            {snapshot.heroChannelId ?? t("superadmin.review.snapshot.notSet")}
          </Typography>
          <Typography variant="body2">
            <strong>{t("onboarding.sections.communityChannel.title")}:</strong>{" "}
            {snapshot.communityChannelId ?? t("superadmin.review.snapshot.notSet")}
          </Typography>
          <Divider sx={{ marginBlockStart: 1, marginBlockEnd: 1 }} />
          <Typography variant="subtitle2">{t("superadmin.review.snapshot.quotasTitle")}</Typography>
          <Typography variant="body2">
            {t("superadmin.review.snapshot.quotas.gcHero")}: {snapshot.quotas.gcHero}
          </Typography>
          <Typography variant="body2">
            {t("superadmin.review.snapshot.quotas.gcTitan")}: {snapshot.quotas.gcTitan}
          </Typography>
          <Typography variant="body2">
            {t("superadmin.review.snapshot.quotas.hol")}: {snapshot.quotas.hol}
          </Typography>
          <Typography variant="body2">
            {t("superadmin.review.snapshot.quotas.hero")}: {snapshot.quotas.hero}
          </Typography>
          <Typography variant="body2">
            {t("superadmin.review.snapshot.quotas.titan")}: {snapshot.quotas.titan}
          </Typography>
        </Stack>
      )}
    </Paper>
  );
}

/**
 * Deliberately shows no fetched data of its own — the orchestrator's own
 * instruction: "nothing else needs to be live-fetched here beyond what the
 * extended GET already returns; don't over-build." This card exists purely
 * to satisfy Section 16's documentation requirement: a Superadmin reviewer
 * must never mistake admin-role policy / notification defaults / live Bunny
 * permission status for something this frozen snapshot covers.
 */
function LiveScopeNoteCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper sx={{ padding: 3 }} component="section" variant="outlined" role="note">
      <Typography variant="subtitle2" sx={{ marginBlockEnd: 0.5 }}>
        {t("superadmin.review.liveScope.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t("superadmin.review.liveScope.body")}
      </Typography>
    </Paper>
  );
}

function AlreadyDecidedCard({ detail }: { detail: ActivationRequestDetailResponse }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Paper sx={{ padding: 3 }} component="section" role="status" data-testid="already-decided">
      <Typography variant="h6" component="h2" sx={{ marginBlockEnd: 1 }}>
        {t("superadmin.review.alreadyDecided.title")}
      </Typography>
      <Typography variant="body2" sx={{ marginBlockEnd: 1 }}>
        {t(`superadmin.review.state.${detail.state}`)}
      </Typography>
      {detail.reviewedBy ? (
        <Typography variant="body2">
          <strong>{t("superadmin.review.metadata.reviewedBy")}:</strong> {detail.reviewedBy}
        </Typography>
      ) : null}
      {detail.reviewedAt ? (
        <Typography variant="body2">
          <strong>{t("superadmin.review.metadata.reviewedAt")}:</strong>{" "}
          {new Date(detail.reviewedAt).toLocaleString()}
        </Typography>
      ) : null}
      {detail.decisionReason ? (
        <Typography variant="body2" sx={{ marginBlockStart: 1 }}>
          <strong>{t("superadmin.review.metadata.decisionReason")}:</strong> {detail.decisionReason}
        </Typography>
      ) : null}
    </Paper>
  );
}

function DecisionActions({ requestId }: { requestId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const approveMutation = useApproveActivationRequestMutation(requestId);
  const rejectMutation = useRejectActivationRequestMutation(requestId);
  const requestChangesMutation = useRequestChangesOnActivationRequestMutation(requestId);

  function onDecisionSuccess(_result: ActivationDecisionResponse, messageKey: string): void {
    showToast({ tone: "success", messageKey });
  }

  function onDecisionError(err: ApiError): void {
    showToast({ tone: "error", messageKey: apiErrorMessageKey(err) });
  }

  const anyPending =
    approveMutation.isPending || rejectMutation.isPending || requestChangesMutation.isPending;

  return (
    <Paper sx={{ padding: 3 }} component="section">
      <Typography variant="h6" component="h2" sx={{ marginBlockEnd: 2 }}>
        {t("superadmin.review.actions.title")}
      </Typography>
      <Stack spacing={3}>
        <Box>
          <Button
            variant="contained"
            color="success"
            disabled={anyPending}
            onClick={() => {
              approveMutation.mutate(undefined, {
                onSuccess: (result) => onDecisionSuccess(result, "superadmin.review.toast.approved"),
                onError: onDecisionError,
              });
            }}
          >
            {t("superadmin.review.actions.approve")}
          </Button>
        </Box>
        <Divider />
        <ReasonAction
          testId="request-changes"
          label={t("superadmin.review.actions.requestChanges")}
          reasonLabel={t("superadmin.review.actions.requestChangesReasonLabel")}
          pending={anyPending}
          onSubmit={(reason) => {
            requestChangesMutation.mutate(reason, {
              onSuccess: (result) => onDecisionSuccess(result, "superadmin.review.toast.changesRequested"),
              onError: onDecisionError,
            });
          }}
        />
        <Divider />
        <ReasonAction
          testId="reject"
          label={t("superadmin.review.actions.reject")}
          reasonLabel={t("superadmin.review.actions.rejectReasonLabel")}
          pending={anyPending}
          buttonColor="error"
          onSubmit={(reason) => {
            rejectMutation.mutate(reason, {
              onSuccess: (result) => onDecisionSuccess(result, "superadmin.review.toast.rejected"),
              onError: onDecisionError,
            });
          }}
        />
      </Stack>
    </Paper>
  );
}

function ReasonAction({
  testId,
  label,
  reasonLabel,
  pending,
  buttonColor,
  onSubmit,
}: {
  testId: string;
  label: string;
  reasonLabel: string;
  pending: boolean;
  buttonColor?: "error";
  onSubmit: (reason: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const trimmed = reason.trim();
  const isValid = trimmed.length > 0 && trimmed.length <= REASON_MAX_LENGTH;

  return (
    <Box>
      <TextField
        fullWidth
        multiline
        minRows={2}
        size="small"
        label={reasonLabel}
        value={reason}
        disabled={pending}
        onChange={(e) => setReason(e.target.value)}
        onBlur={() => setTouched(true)}
        error={touched && !isValid}
        helperText={touched && !isValid ? t("errors.validation") : undefined}
        data-testid={`${testId}-reason`}
        sx={{ marginBlockEnd: 1 }}
      />
      <Button
        variant="outlined"
        color={buttonColor}
        disabled={pending || !isValid}
        data-testid={`${testId}-submit`}
        onClick={() => {
          setTouched(true);
          if (!isValid) return;
          onSubmit(trimmed);
        }}
      >
        {label}
      </Button>
    </Box>
  );
}
