/**
 * `createNotification()` — the ONE canonical internal entrypoint every
 * later feature step calls (this step's task brief: "do not scatter INSERT
 * logic across routes"). Logical order (task brief, verbatim numbering):
 *
 *   1. establish/reuse notification_id
 *   2. create/ensure dashboard_notifications row
 *   3. resolve effective preferences
 *   4. create/ensure IN_APP delivery (SENT if enabled, SKIPPED_PREFERENCE if not)
 *   5. create/ensure DISCORD_DM delivery (PENDING if enabled, SKIPPED_PREFERENCE if not)
 *   6. if DM enabled: enqueue the real operator_commands SEND_DM row
 *   7. store operator_command_id on the delivery row
 *   8. commit as ONE transaction
 *   9. SSE notification.created is derived from the durable row afterward
 *      (the SSE poller's own registered source adapter, sseAdapter.ts —
 *      NOT this function's job to push an event itself)
 *
 * A path that enqueues/sends a DM without first having a durable in-app row
 * is structurally impossible here: everything happens inside ONE
 * `db.transaction()`, and the `operator_commands` insert (step 6) only ever
 * runs after steps 2-5 have already been built into the SAME transaction —
 * if the transaction rolls back for any reason, the SEND_DM enqueue rolls
 * back with it, never the other way around.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import {
  NOTIFICATION_DM_FOOTER_KEY,
  NOTIFICATION_EVENT_REGISTRY,
  FALLBACK_LOCALE,
  isSupportedLocale,
  type NotificationEventType,
} from "@bunny-command-center/shared";
import { findDashboardUserById } from "../auth/userRepo.js";
import { generateNotificationId } from "./id.js";
import { renderMessage } from "./render.js";
import { resolveRequestedBy } from "./requestedBy.js";
import { buildSendDmPayloadJsonText } from "./sendDmPayload.js";
import {
  ensureDeliveryRow,
  ensureNotificationRow,
  ensureSendDmOperatorCommand,
  getDiscordDmDeliveryOperatorCommandId,
  resolvePreference,
  setDeliveryOperatorCommandId,
  updateDiscordDmDeliveryState,
} from "./repo.js";

/** Minimal logger shape — accepts `request.log`/`fastify.log` (Fastify's `FastifyBaseLogger`) without depending on Fastify's types here. Defaults to `console` so every existing caller (tests, scripts) keeps working unchanged. */
export interface MinimalLogger {
  error(obj: unknown, msg?: string): void;
}

export interface CreateNotificationParams {
  /** Retry-safe: pass the SAME id when retrying the same logical creation (task brief correction #5) — omit to generate a fresh one. */
  notificationId?: string;
  /** `dashboard_users.id` — the RECIPIENT/owner of this notification, never confused with the human actor who may have triggered it (`triggeredBy`, below — a distinct concept: WHO gets the notification vs WHO caused it to be created). */
  userId: number;
  eventType: NotificationEventType;
  parameters: Readonly<Record<string, unknown>>;
  guildId?: string | null;
  deeplinkPath: string;
  /** The real acting human user, if any (e.g. a Guild Admin's own "send reminder" click) — omit entirely for a system-generated notification (upload completed, badge earned, ...) with no human actor. Drives `operator_commands.requested_by_discord_id`/`requested_by_role` (ADR-013, corrected 2026-08-11). */
  triggeredBy?: { discordUserId: string; role?: string };
}

export interface CreateNotificationResult {
  readonly notificationId: string;
  readonly inAppEnabled: boolean;
  readonly discordDmEnabled: boolean;
}

export async function createNotification(
  db: Kysely<DB>,
  config: AppConfig,
  params: CreateNotificationParams,
  logger: MinimalLogger = console,
): Promise<CreateNotificationResult> {
  const id = params.notificationId ?? generateNotificationId();
  const def = NOTIFICATION_EVENT_REGISTRY[params.eventType];
  const guildId = params.guildId ?? null;

  return db.transaction().execute(async (trx) => {
    const recipient = await findDashboardUserById(trx, params.userId);
    if (!recipient) {
      throw new Error(`createNotification: no dashboard_users row for id=${params.userId}`);
    }

    // Step 2.
    await ensureNotificationRow(trx, {
      id,
      userId: params.userId,
      eventType: params.eventType,
      messageKey: def.messageKey,
      parameters: params.parameters,
      guildId,
      deeplinkPath: params.deeplinkPath,
    });

    // Step 3.
    const preference = await resolvePreference(trx, params.userId, params.eventType);

    // Step 4.
    await ensureDeliveryRow(trx, {
      notificationId: id,
      channel: "IN_APP",
      state: preference.inAppEnabled ? "SENT" : "SKIPPED_PREFERENCE",
    });

    // Steps 5-7.
    if (preference.discordDmEnabled) {
      await ensureDeliveryRow(trx, { notificationId: id, channel: "DISCORD_DM", state: "PENDING" });

      // External-review item 6: if a PRIOR call for this SAME notification
      // id already bound a real operator_commands row, never build/enqueue
      // again — the composite UNIQUE(requested_by_discord_id, target_service,
      // idempotency_key) constraint alone does NOT catch a retry whose
      // `triggeredBy` actor differs from the first call's (a different
      // requested_by_discord_id does not collide with it), which would
      // otherwise insert a genuine second operator_commands row and send a
      // second DM. The first durable association wins; this retry is a
      // structural no-op — never mutates the historical actor.
      const alreadyBoundCommandId = await getDiscordDmDeliveryOperatorCommandId(trx, id);
      if (alreadyBoundCommandId !== null) {
        return {
          notificationId: id,
          inAppEnabled: preference.inAppEnabled,
          discordDmEnabled: preference.discordDmEnabled,
        };
      }

      // ADR-013 / this step's own scope note: "A failed DM must NEVER lose
      // the underlying notification or block any other part of the
      // system." That invariant applies to a failure IN THIS BUILD/ENQUEUE
      // STEP too, not only to a later delivery failure Bunny reports back —
      // found for real (not hypothetical) via this step's own Playwright
      // E2E suite: the E2E test-login fixture's default Discord user id
      // ("900000000001", 12 digits) is not a syntactically valid Snowflake,
      // and `buildSendDmPayloadJsonText` correctly throws for it — but
      // letting that exception propagate would abort the WHOLE transaction,
      // silently losing the notification and IN_APP delivery over a
      // DM-specific data problem. Caught here instead: the notification and
      // IN_APP delivery (already built above, same transaction) commit
      // normally; only the DISCORD_DM delivery is marked FAILED.
      try {
        const locale = isSupportedLocale(recipient.locale) ? recipient.locale : FALLBACK_LOCALE;
        const content = renderMessage(locale, def.messageKey, params.parameters);
        const footer = config.publicUrl
          ? renderMessage(locale, NOTIFICATION_DM_FOOTER_KEY, {
              url: `${config.publicUrl}/notifications/preferences`,
            })
          : "";
        const payloadJsonText = buildSendDmPayloadJsonText({
          discordUserId: recipient.discord_user_id,
          content,
          footer,
          correlationId: id,
        });

        const requestedBy = resolveRequestedBy(config, params.triggeredBy);
        const commandId = generateNotificationId();
        const authoritativeCommandId = await ensureSendDmOperatorCommand(trx, {
          commandId,
          idempotencyKey: id,
          guildId,
          requestedByDiscordId: requestedBy.discordUserId,
          requestedByRole: requestedBy.role,
          payloadJsonText,
        });
        await setDeliveryOperatorCommandId(trx, {
          notificationId: id,
          operatorCommandId: authoritativeCommandId,
        });
      } catch (err) {
        logger.error(
          { err, notificationId: id },
          "notifications: failed to build/enqueue SEND_DM — the in-app record stays intact, delivery marked FAILED",
        );
        await updateDiscordDmDeliveryState(trx, id, "FAILED");
      }
    } else {
      await ensureDeliveryRow(trx, {
        notificationId: id,
        channel: "DISCORD_DM",
        state: "SKIPPED_PREFERENCE",
      });
    }

    return {
      notificationId: id,
      inAppEnabled: preference.inAppEnabled,
      discordDmEnabled: preference.discordDmEnabled,
    };
  });
}
