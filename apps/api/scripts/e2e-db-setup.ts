/**
 * Prepares the disposable E2E database + accounts BEFORE
 * apps/api/scripts/e2e-server.ts starts (apps/web/playwright.config.ts's
 * webServer command chains this first). Uses root credentials exactly like
 * the existing CI workflow's own "Create Dashboard DB accounts" step
 * (.github/workflows/ci.yml) - both are disposable local/CI-only MySQL
 * instances, never production.
 *
 * Deliberately NOT a Playwright `globalSetup` hook: Playwright starts
 * `webServer` processes BEFORE running `globalSetup` (verified against the
 * installed `playwright` package's own task ordering -
 * `createPluginSetupTasks` runs ahead of `config.globalSetups` mapping), so
 * a `globalSetup`-based approach would race the very webServer it's meant to
 * prepare for.
 */
import mysql from "mysql2/promise";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable for E2E DB setup: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const rootConfig = {
    host: process.env["E2E_MYSQL_ROOT_HOST"] ?? "127.0.0.1",
    port: Number(process.env["E2E_MYSQL_ROOT_PORT"] ?? 3306),
    user: "root",
    password: required("E2E_MYSQL_ROOT_PASSWORD"),
  };
  const dbName = required("E2E_DB_NAME");
  const appUser = required("E2E_APP_DB_USER");
  const appPassword = required("E2E_APP_DB_PASSWORD");
  const migratorUser = required("E2E_MIGRATOR_DB_USER");
  const migratorPassword = required("E2E_MIGRATOR_DB_PASSWORD");

  const admin = await mysql.createConnection(rootConfig);
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\``);
    await admin.query(`CREATE USER IF NOT EXISTS '${appUser}'@'%' IDENTIFIED BY '${appPassword}'`);
    await admin.query(`ALTER USER '${appUser}'@'%' IDENTIFIED BY '${appPassword}'`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${dbName}\`.* TO '${appUser}'@'%'`);
    await admin.query(`CREATE USER IF NOT EXISTS '${migratorUser}'@'%' IDENTIFIED BY '${migratorPassword}'`);
    await admin.query(`ALTER USER '${migratorUser}'@'%' IDENTIFIED BY '${migratorPassword}'`);
    await admin.query(`GRANT ALL PRIVILEGES ON *.* TO '${migratorUser}'@'%'`);
    await admin.query("FLUSH PRIVILEGES");
  } finally {
    await admin.end();
  }
  console.log(`[e2e-db-setup] database "${dbName}" and accounts ready`);
}

void main();
