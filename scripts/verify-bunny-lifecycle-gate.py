"""Step 10 (Guild Lifecycle, Onboarding & Approval) — real Bunny-gate proof.

DASHBOARD/IMPLEMENTATION/10_onboarding_approval.md's §PROOF OF WIRING requires
verifying "Step 08's Bunny-side `guilds.enabled` gate actually rejects ingestion
for a DISCOVERED/PENDING_APPROVAL guild in a real (not mocked) integration test
against Bunny's code, not merely assumed from its handover text."

This script does exactly that, from OUTSIDE the Bunny OCR repo (02_NEW_BOT_OCR),
which is read-only for this Dashboard-side step: it imports Bunny's real,
UNMODIFIED `functions/ingestion_scheduler.py` module (no copy-pasted logic, no
reimplementation of its gate) and calls its real `_is_guild_ingestion_enabled()`
against real rows in a real, disposable MySQL database migrated through the real
shared migration ledger (via `01_NEW_SELF_BOTS/database/migrate.py`, through
migration 0015 — the one that adds `guilds.lifecycle_state`).

This is a standalone verification script, not part of the `npm test`/vitest
pipeline — this repo (a Node/TypeScript monorepo) has no existing Python test
orchestration, and this proof inherently needs to run Bunny's real Python code,
so inventing one just for this single script would be more machinery than the
one-time proof warrants. Run it manually (or wire it into a CI step later if a
dedicated cross-repo verification job is ever added) whenever this gate's real
behavior needs re-proving — e.g. after a Bunny OCR or shared-schema change.

------------------------------------------------------------------------------
HOW TO RUN
------------------------------------------------------------------------------

Prerequisites:
  1. A disposable MySQL 8.0.x instance reachable from this machine (this repo's
     own real-MySQL tests already use one — see `apps/api/test/lifecycle/
     routes.test.ts`'s `TEST_MYSQL_HOST`/`TEST_MYSQL_PORT`/`TEST_MYSQL_ROOT_PASSWORD`
     env vars for the exact convention; any MySQL 8.0.39 instance works).
  2. That instance migrated through the REAL shared ledger via the Self-bot
     repo's own migrator:

       cd 01_NEW_SELF_BOTS
       MIGRATOR_DB_HOST=<host> MIGRATOR_DB_PORT=<port> MIGRATOR_DB_USER=root \
       MIGRATOR_DB_PASSWORD=<password> MIGRATOR_DB_NAME=<disposable_db_name> \
       RUNNER_ENV=TEST python database/migrate.py up

  3. Bunny OCR's own Python virtualenv (`02_NEW_BOT_OCR/.venv-test`, the same
     one its own test suite uses) has the dependencies this script's import of
     `functions.ingestion_scheduler` needs (sqlalchemy, aiomysql) — it does,
     since that module is Bunny's own production code.

Then, from this repo's root (bunny-command-center):

    "../02_NEW_BOT_OCR/.venv-test/Scripts/python.exe" scripts/verify-bunny-lifecycle-gate.py \
        --mysql-host 127.0.0.1 --mysql-port 33070 --mysql-user root \
        --mysql-password devrootpass --mysql-database <disposable_db_name>

(adjust the venv path/python executable for your platform — on Linux/macOS it's
`.venv-test/bin/python`).

The script seeds its own two guild rows directly (harmless if re-run — it
upserts by `guild_id`), points Bunny's real `functions.db_models.load_db_config()`
at the disposable database via a temporary `db_params.json` + `CONFIG_DIR` env
var (Bunny's own documented config-loading mechanism, never touched or
special-cased for this proof), and exits non-zero with a clear message if any
assertion fails.

------------------------------------------------------------------------------
WHAT IT PROVES
------------------------------------------------------------------------------

  1. A guild with `lifecycle_state='PENDING_APPROVAL', enabled=0` is reported
     as ingestion-NOT-enabled by Bunny's real gate (no new real scan would be
     scheduled for it).
  2. A guild with `lifecycle_state='ACTIVE', enabled=1` is reported as
     ingestion-enabled (scheduling would proceed to Bunny's next real seam).
  3. A DB error while checking the gate is treated as NOT enabled (fails
     closed) — proven by pointing the same real function at an unreachable
     host/port and confirming it still returns `False`, never raises past the
     function's own boundary and never defaults to "enabled".

No mocks anywhere in this script: real MySQL, real rows, real unmodified Bunny
code (`sys.path` import, read-only — this script never writes to
`02_NEW_BOT_OCR`). No real Discord network call is made — verified separately,
by reading `functions/ingestion_scheduler.py` before writing this script, that
it has no module-level Discord client construction/connection (unlike
`main_bot_task_ocr.py`, which does and must never be imported by a test).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUNNY_REPO = (REPO_ROOT / ".." / "02_NEW_BOT_OCR").resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("HOW TO RUN")[0])
    parser.add_argument("--mysql-host", default=os.getenv("TEST_MYSQL_HOST", "127.0.0.1"))
    parser.add_argument("--mysql-port", type=int, default=int(os.getenv("TEST_MYSQL_PORT", "33070")))
    parser.add_argument("--mysql-user", default=os.getenv("TEST_MYSQL_USER", "root"))
    parser.add_argument(
        "--mysql-password", default=os.getenv("TEST_MYSQL_ROOT_PASSWORD", "devrootpass")
    )
    parser.add_argument("--mysql-database", required=True)
    parser.add_argument(
        "--pending-guild-id",
        type=int,
        default=700000000000000001,
        help="Guild id to seed as lifecycle_state=PENDING_APPROVAL, enabled=0",
    )
    parser.add_argument(
        "--active-guild-id",
        type=int,
        default=700000000000000002,
        help="Guild id to seed as lifecycle_state=ACTIVE, enabled=1",
    )
    return parser.parse_args()


def seed_guild_rows(args: argparse.Namespace) -> None:
    """Direct DBAPI upsert of the two proof rows — deliberately NOT going
    through any application code on either side (this script is exercising
    Bunny's READ gate, not any writer path)."""
    import pymysql

    conn = pymysql.connect(
        host=args.mysql_host,
        port=args.mysql_port,
        user=args.mysql_user,
        password=args.mysql_password,
        database=args.mysql_database,
    )
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO guilds (guild_id, enabled, lifecycle_state)
                VALUES (%s, 0, 'PENDING_APPROVAL')
                ON DUPLICATE KEY UPDATE enabled=0, lifecycle_state='PENDING_APPROVAL'
                """,
                (args.pending_guild_id,),
            )
            cursor.execute(
                """
                INSERT INTO guilds (guild_id, enabled, lifecycle_state)
                VALUES (%s, 1, 'ACTIVE')
                ON DUPLICATE KEY UPDATE enabled=1, lifecycle_state='ACTIVE'
                """,
                (args.active_guild_id,),
            )
        conn.commit()
    finally:
        conn.close()


def write_bunny_db_config(args: argparse.Namespace, config_dir: Path) -> None:
    """Writes a `db_params.json` matching Bunny's own documented
    `functions.db_models.load_db_config()` shape (DEV mode file name,
    BOT_MODE defaults to DEV) — never edits anything inside 02_NEW_BOT_OCR
    itself, this file lives entirely under our own temp directory."""
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "db_params.json").write_text(
        json.dumps(
            {
                "user": args.mysql_user,
                "password": args.mysql_password,
                # Bunny's db_models.py builds "mysql+aiomysql://user:password@host/db"
                # with no separate port field - embed the port in the host string,
                # which SQLAlchemy's URL parser accepts.
                "host": f"{args.mysql_host}:{args.mysql_port}",
                "database": args.mysql_database,
            }
        ),
        encoding="utf-8",
    )


async def run_gate_checks(args: argparse.Namespace) -> list[str]:
    """Imports Bunny's REAL, unmodified module and exercises its real
    function. Returns a list of failure messages (empty = all assertions
    passed)."""
    sys.path.insert(0, str(BUNNY_REPO))
    from functions import ingestion_scheduler  # type: ignore[import-not-found]

    failures: list[str] = []

    pending_enabled = await ingestion_scheduler._is_guild_ingestion_enabled(args.pending_guild_id)
    if pending_enabled is not False:
        failures.append(
            f"PENDING_APPROVAL/enabled=0 guild {args.pending_guild_id}: expected "
            f"_is_guild_ingestion_enabled() == False, got {pending_enabled!r}"
        )

    active_enabled = await ingestion_scheduler._is_guild_ingestion_enabled(args.active_guild_id)
    if active_enabled is not True:
        failures.append(
            f"ACTIVE/enabled=1 guild {args.active_guild_id}: expected "
            f"_is_guild_ingestion_enabled() == True, got {active_enabled!r}"
        )

    # Fail-closed-on-DB-error proof: reuse the SAME real function, but force
    # the module's cached engine to point at an unreachable target first, so
    # the very next call inside it hits a genuine connection failure - not a
    # simulated exception, a real one.
    import functions.db_models as db_models  # type: ignore[import-not-found]

    db_models._async_engine = None
    db_models._async_session = None
    original_config_dir = db_models.CONFIG_DIR
    with tempfile.TemporaryDirectory() as broken_dir:
        broken_config_dir = Path(broken_dir)
        write_bunny_db_config(
            argparse.Namespace(
                mysql_host="127.0.0.1",
                mysql_port=1,  # nothing listens here
                mysql_user=args.mysql_user,
                mysql_password=args.mysql_password,
                mysql_database=args.mysql_database,
            ),
            broken_config_dir,
        )
        db_models.CONFIG_DIR = str(broken_config_dir)
        try:
            db_error_result = await ingestion_scheduler._is_guild_ingestion_enabled(args.active_guild_id)
            if db_error_result is not False:
                failures.append(
                    "DB-error fail-closed check: expected _is_guild_ingestion_enabled() "
                    f"== False when the DB is unreachable, got {db_error_result!r}"
                )
        finally:
            db_models.CONFIG_DIR = original_config_dir
            db_models._async_engine = None
            db_models._async_session = None

    return failures


def main() -> int:
    args = parse_args()

    if not BUNNY_REPO.is_dir():
        print(f"ERROR: expected Bunny OCR repo at {BUNNY_REPO}, not found.", file=sys.stderr)
        return 2

    print(f"[verify-bunny-lifecycle-gate] seeding guild rows in {args.mysql_database} ...")
    seed_guild_rows(args)

    with tempfile.TemporaryDirectory() as tmp:
        config_dir = Path(tmp) / "config"
        write_bunny_db_config(args, config_dir)
        os.environ["CONFIG_DIR"] = str(config_dir)
        os.environ.setdefault("BOT_MODE", "DEV")

        print("[verify-bunny-lifecycle-gate] importing Bunny's real functions.ingestion_scheduler ...")
        failures = asyncio.run(run_gate_checks(args))

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print(
        "\nPASSED: Bunny's real guilds.enabled ingestion gate correctly rejects a "
        "PENDING_APPROVAL/enabled=0 guild, allows an ACTIVE/enabled=1 guild, and "
        "fails closed on a real DB error."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
