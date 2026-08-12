import mysql from "mysql2/promise";
import type { DbConfig } from "./config.js";
import { DASHBOARD_MIGRATION_LEDGER_TABLE as LEDGER_TABLE } from "./db/constants.js";

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
}

/**
 * /readyz's real check (04_GLOBAL_TECHNICAL_ARCHITECTURE.md, Step 01 scope):
 * MySQL must be reachable AND the Dashboard's own migration ledger must be
 * bootstrapped and free of STARTED/FAILED rows. No shared-schema
 * SUPPORTED_SCHEMA_MAX floor is checked yet — Step 01 introduces no
 * Dashboard feature that depends on one (the first real dependency,
 * web_upload_intake, arrives in Step 07; see 06_VERSIONING_AND_COMPATIBILITY.md).
 *
 * Uses its own short-lived connection (deliberately NOT the app's shared
 * Kysely pool) with a tight connect timeout so an unreachable DB fails fast
 * instead of hanging the request.
 */
export async function checkReadiness(config: DbConfig): Promise<ReadinessResult> {
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 3000,
    });
  } catch (err) {
    return { ready: false, reason: `database unreachable: ${(err as Error).message}` };
  }

  try {
    const [tableRows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1",
      [LEDGER_TABLE],
    );
    if (tableRows.length === 0) {
      return {
        ready: false,
        reason: `Dashboard migration ledger (${LEDGER_TABLE}) not yet bootstrapped; run the migrator ('up').`,
      };
    }

    const [badRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT version, state FROM ${LEDGER_TABLE} WHERE state IN ('STARTED', 'FAILED')`,
    );
    if (badRows.length > 0) {
      const detail = badRows.map((r) => `${r.version as string}=${r.state as string}`).join(", ");
      return { ready: false, reason: `Dashboard migration ledger not clean: ${detail}` };
    }

    return { ready: true };
  } catch (err) {
    return { ready: false, reason: `readiness query failed: ${(err as Error).message}` };
  } finally {
    await conn.end().catch(() => undefined);
  }
}
