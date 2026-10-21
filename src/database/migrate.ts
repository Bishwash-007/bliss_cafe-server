import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  checksumOf,
  MigrationRunner,
  parseMarkers,
  type MigrationFile,
} from './migration-runner';
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

async function main(): Promise<void> {
  const allowChecksumDrift = process.argv.includes('--allow-checksum-drift');
  const migrationsDir = resolveMigrationsDir();

  const files = await readMigrations(migrationsDir);
  if (files.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const pool = new Pool(databaseConfigFromEnv());
  const client = await pool.connect();

  try {
    const runner = new MigrationRunner(client, {
      allowChecksumDrift,
      log: (message) => console.log(`[migrate] ${message}`),
    });

    const report = await runner.run(files);

    console.log(
      `[migrate] ${report.applied.length} applied, ` +
        `${report.baselined.length} already in the schema, ` +
        `${report.skipped.length} already recorded.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Finds `db/migrations`.
 *
 * The path is resolved by walking up from this file, so the same command
 * works from the source tree (`src/database`), from the compiled build
 * (`dist/database`) and from inside the runtime image, where the migrations
 * are copied next to `dist`.
 */
function resolveMigrationsDir(): string {
  const candidates: string[] = [];
  let directory = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(directory, 'db', 'migrations'));
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  candidates.push(resolve(process.cwd(), 'db', 'migrations'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not find db/migrations. Run this from the project root, or from an ' +
      'image that ships the db/ directory.',
  );
}

/** Reads the migration files, in the order they must be applied. */
async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    // The numeric prefix is the order: 002 before 010, and `10_` before `2_`.
    .sort((left, right) => left.localeCompare(right, 'en'));

  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(directory, name), 'utf8');
    files.push({
      name,
      sql,
      checksum: checksumOf(sql),
      markers: parseMarkers(sql),
    });
  }
  return files;
}

main().catch((error: unknown) => {
  console.error(`[migrate] ${(error as Error).message}`);
  process.exitCode = 1;
});
