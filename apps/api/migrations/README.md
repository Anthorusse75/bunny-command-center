# Dashboard migration ledger

Owns **only** Dashboard-exclusive tables (`25_DATA_MODEL.md`'s DASHBOARD-OWNED
list). Never touches a shared table — that ledger lives in
`01_NEW_SELF_BOTS/database/migrations/` and is applied first, before this one,
in every environment (`ADR-011`).

## Conventions (mirrors `01_NEW_SELF_BOTS/database/migrations/README.md`)

- Numbered, zero-padded to 4 digits, starting at `0001`.
- Each migration is a pair: `NNNN_description.up.sql` / `NNNN_description.down.sql`.
- Applied strictly in numeric order.
- Each `CREATE TABLE`/`ALTER TABLE`/`CREATE INDEX` is its own top-level
  statement terminated by `;` — the runner splits and executes
  statement-by-statement, journaling progress, because MySQL/InnoDB DDL
  carries an implicit commit (a failed migration is not atomically rolled
  back).
- `.down.sql` files are for `TEST`/`LOCAL_DISPOSABLE` environments only —
  never a production rollback strategy (`RUNNER_ENV` gate in `cli.ts`).
- Every `CREATE TABLE` name must be `dashboard_`-prefixed or in the explicit
  allowlist in `additive-audit.ts` (`upload_sessions`, `upload_items`,
  `badge_definitions`, `badge_awards`, `hero_discovery_decisions`,
  `hero_discovery_config`) — enforced by a static test, not just convention.
- No `DROP`/`MODIFY`/`CHANGE COLUMN` — additive-only, enforced by the same
  static test.

## Ledger

| Version                                               | Table                              | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_create_dashboard_sse_cursor`                    | `dashboard_sse_cursor`             | 03 (`03_realtime_infrastructure.md`) — durable per-(source_table, cursor_key) watermark backing the SSE poller's Last-Event-ID resume. See the migration file's own header comment for the full rationale. `26_REALTIME_SSE_AND_SYNC.md` was never modified; `25_DATA_MODEL.md`'s one-line summary for this table WAS corrected (2026-08-16, reviewer-authorized erratum — it directly contradicted `26`'s own operative description; see the migration header). |
| `0002_create_dashboard_users`                         | `dashboard_users`                  | 04 (`04_discord_oauth_sessions.md`) — one row per Discord user who has ever logged in; `discord_user_id` is `VARCHAR(24)`, never numeric (Snowflake-precision correction, see migration header).                                                                                                                                                                                                                                                                 |
| `0003_create_dashboard_sessions`                      | `dashboard_sessions`               | 04 — server-side, MySQL-backed session store (ADR-020's sliding/absolute TTL).                                                                                                                                                                                                                                                                                                                                                                                   |
| `0004_create_dashboard_guild_policy`                  | `dashboard_guild_policy`           | 05 (`05_rbac_superadmin_idor.md`, ADR-007) — per-guild configured Dashboard-admin-role reference; `guild_id`/`admin_role_discord_id` are `VARCHAR(24)`, never numeric.                                                                                                                                                                                                                                                                                           |
| `0005_create_dashboard_admin_overrides`               | `dashboard_admin_overrides`        | 05 — per-(guild, user) individual `ADMIN_DISABLED` override, toggled in place, never hard-deleted (ADR-007).                                                                                                                                                                                                                                                                                                                                                     |
| `0006_create_dashboard_user_guild_preferences`        | `dashboard_user_guild_preferences` | 06 (`06_multi_guild_navigation.md`) — per-(user, guild) favorite/home-visibility/last-used preferences. Does **not** carry `last_upload_guild_id` despite `25_DATA_MODEL.md`'s literal column list — see migration header for the documented operator-resolved deviation (moved to `dashboard_users`, migration 0007, since Upload is a GLOBAL route with no per-guild context).                                                                                 |
| `0007_alter_dashboard_users_add_last_upload_guild_id` | `dashboard_users` (ALTER)          | 06 — additive `last_upload_guild_id VARCHAR(24) NULL` column; the operator-resolved home for "which guild did this user last upload to" (see migration 0006's header for the full rationale).                                                                                                                                                                                                                                                                    |

As of Step 01, this directory intentionally contained **zero** `.sql`
files — the mechanism itself (apply / idempotent reapply / checksum-mismatch
rejection) was proven by `apps/api/test/migrations-runner.test.ts` against an
isolated fixture directory (`apps/api/test/fixtures/migrations/`), and
additionally proven manually end-to-end against a real MySQL instance using a
temporary `_scaffold_probe` migration that was removed again before that step
was finalized (see the Step 01 HANDOVER for the transcript). Step 03 added
the first real entry above.

## Usage

```
npm run migrate -- up
npm run migrate -- up --force-retry
npm run migrate -- down --to 0003
npm run migrate -- status
```

Connection info: `MIGRATOR_DB_HOST`/`PORT`/`USER`/`PASSWORD`/`NAME`,
`RUNNER_ENV` (see `apps/api/.env.example`). Distinct from the runtime app's
`DB_*` config — this account needs DDL privileges, the runtime account
should not have them.
