export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  db: DbConfig;
  appVersion: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Reads the RUNTIME app's DB connection (DB_*) — deliberately distinct from
 * MIGRATOR_DB_* (see migrations/config.ts), which only the migration runner
 * reads. This function is called at server startup so a missing DB_* var
 * fails fast; an unreachable *value* (bad host/port) must NOT throw here —
 * only /readyz, not /healthz or startup, is allowed to observe that.
 */
export function loadAppConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    logLevel: process.env.LOG_LEVEL ?? "info",
    db: {
      host: required("DB_HOST"),
      port: Number(process.env.DB_PORT ?? 3306),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      database: required("DB_NAME"),
    },
    appVersion: process.env.DASHBOARD_APP_VERSION ?? "0.1.0-scaffold",
  };
}
