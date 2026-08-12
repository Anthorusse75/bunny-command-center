import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import type { DbConfig } from "../config.js";
import type { DB } from "./codegen-types.js";

/**
 * Typed query client for the runtime app (ADR-022). Never issues DDL — the
 * migration runner (apps/api/migrations/) is the only thing allowed to.
 */
export function createKyselyClient(config: DbConfig): Kysely<DB> {
  const dialect = new MysqlDialect({
    pool: createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 10,
    }),
  });

  return new Kysely<DB>({ dialect });
}
