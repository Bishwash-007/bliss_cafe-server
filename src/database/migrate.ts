import { Pool } from 'pg';
import { MigrationRunner, type MigrationReport } from './migration-runner';
import { readMigrations, resolveMigrationsDir } from './migration-files';
import { databaseConfigFromEnv } from '../tenant/connection/pg-pool.provider';

/**
 * # `npm run db:migrate`
 *
 * Applies the pending migrations in `db/migrations` to the configured
 * database, and records them in `schema_migrations`.
 *
 * It is meant to run BEFORE the API starts — once per deploy, as a step of its
 * own — so a release that needs a schema change is a release that has it.
 * Running it twice is harmless: the second run finds nothing to do.
 *
 * ## Exit codes
 *
 *  - `0` — the schema is up to date (nothing applied, or everything applied).
 *  - `1` — a migration failed, or the database is in a state the runner
 *    refuses to guess about. The message says which file and why.
 */

/** The parts of the command the outside world may replace. */
export interface MigrationCommandOptions {
  /** The pool to use; a real one is created when this is not given. */
  readonly pool?: Pool;
  /** Where the progress lines go. */
  readonly log?: (message: string) => void;
}

/**
 * Runs the migration command.
 *
 * The pool is injectable so the command can be exercised without a database.
 */
export async function runMigrationCommand(
  options: MigrationCommandOptions = {},
): Promise<MigrationReport> {
  const log = options.log ?? console.log;

  const allowChecksumDrift = process.argv.includes('--allow-checksum-drift');
  const migrationsDir = resolveMigrationsDir();

  const files = await readMigrations(migrationsDir);
  if (files.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const pool = options.pool ?? new Pool(databaseConfigFromEnv());
  const client = await pool.connect();

  try {
    const runner = new MigrationRunner(client, {
      allowChecksumDrift,
      log: (message) => log(`[migrate] ${message}`),
    });

    const report = await runner.run(files);

    log(
      `[migrate] ${report.applied.length} applied, ` +
        `${report.baselined.length} already in the schema, ` +
        `${report.skipped.length} already recorded.`,
    );
    return report;
  } finally {
    client.release();
    if (options.pool === undefined) {
      await pool.end();
    }
  }
}

/* istanbul ignore next -- the process entry point */
if (require.main === module) {
  runMigrationCommand().catch((error: unknown) => {
    console.error(`[migrate] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
