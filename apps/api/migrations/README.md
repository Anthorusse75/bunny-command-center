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

| Version                            | Table                  | Step                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_create_dashboard_sse_cursor` | `dashboard_sse_cursor` | 03 (`03_realtime_infrastructure.md`) — durable per-(source_table, cursor_key) watermark backing the SSE poller's Last-Event-ID resume. See the migration file's own header comment for the full rationale; neither frozen document (`25_DATA_MODEL.md`, `26_REALTIME_SSE_AND_SYNC.md`) was modified by Step 03. |

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
