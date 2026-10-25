import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  checksumOf,
  parseMarkers,
  type MigrationFile,
} from './migration-runner';

/**
 * Finding and reading the migration files.
 *
 * Kept apart from the command-line entry point so it can be tested without
 * running a migration: importing the entry point would start it.
 */

/**
 * Finds `db/migrations`.
 *
 * The path is resolved by walking up from this file, so the same command works
 * from the source tree (`src/database`), from the compiled build
 * (`dist/database`) and from inside the runtime image, where the migrations
 * are copied next to `dist`.
 */
export function resolveMigrationsDir(): string {
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

/**
 * Reads the migration files, in the order they must be applied.
 *
 * The order is the file name's order: the numeric prefix is the order, so
 * `002` comes before `010`, and `10_` comes before `2_` — the comparison is
 * lexical, not numeric, so the prefixes must be zero-padded.
 */
export async function readMigrations(
  directory: string,
): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
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
