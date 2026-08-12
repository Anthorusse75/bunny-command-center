export interface MigratorDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export type RunnerEnv = "PRODUCTION" | "TEST" | "LOCAL_DISPOSABLE";
const ALLOWED_RUNNER_ENVS: RunnerEnv[] = ["PRODUCTION", "TEST", "LOCAL_DISPOSABLE"];
export const ALLOWED_DOWN_ENVS: RunnerEnv[] = ["TEST", "LOCAL_DISPOSABLE"];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Set MIGRATOR_DB_HOST/PORT/USER/PASSWORD/NAME ` +
        "— a DISTINCT, DDL-privileged account from the runtime app's DB_* config " +
        "(mirrors 01_NEW_SELF_BOTS/database/migrate.py's convention).",
    );
  }
  return value;
}

export function loadMigratorDbConfig(env: NodeJS.ProcessEnv = process.env): MigratorDbConfig {
  return {
    host: required(env, "MIGRATOR_DB_HOST"),
    port: Number(env.MIGRATOR_DB_PORT ?? 3306),
    user: required(env, "MIGRATOR_DB_USER"),
    password: required(env, "MIGRATOR_DB_PASSWORD"),
    database: required(env, "MIGRATOR_DB_NAME"),
  };
}

/** Fail-safe: no RUNNER_ENV means treat this as production (up-only). */
export function loadRunnerEnv(env: NodeJS.ProcessEnv = process.env): RunnerEnv {
  const raw = env.RUNNER_ENV;
  if (!raw) {
    return "PRODUCTION";
  }
  const value = raw.trim().toUpperCase();
  if (!ALLOWED_RUNNER_ENVS.includes(value as RunnerEnv)) {
    throw new Error(`Invalid RUNNER_ENV=${raw}; must be one of ${ALLOWED_RUNNER_ENVS.join(", ")}.`);
  }
  return value as RunnerEnv;
}
