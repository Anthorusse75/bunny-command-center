/**
 * Lives under src/ (not migrations/) specifically so the production build
 * (tsconfig.build.json, rootDir: src) never needs to reach outside src/ -
 * migrations/runner.ts imports this constant from here instead of the other
 * way around, keeping the dependency direction one-way.
 */
export const DASHBOARD_MIGRATION_LEDGER_TABLE = "dashboard_schema_migrations";
