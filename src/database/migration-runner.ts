import { createHash } from 'node:crypto';

/**
 * # Migration runner
 *
 * The schema in `db/migrations` used to be applied by mounting the folder into
 * `/docker-entrypoint-initdb.d`: Postgres runs those files ONCE, when it
 * initialises an EMPTY data directory. That is fine for a laptop and useless
 * for a deployment — a released migration never reaches an existing database,
 * and the only way to change a production schema is to recreate it and lose
 * the data.
 *
 * This runner is the other half: it applies pending migrations to a database
 * that is already running, records what it applied in `schema_migrations`, and
 * is safe to run on every deploy.
 *
 * ## How a migration is decided to be "already applied"
 *
 * Two independent mechanisms, in this order:
 *
 *  1. **The ledger.** `schema_migrations` holds the files that were applied by
 *     THIS runner, with their checksum. A file that is in the ledger is
 *     skipped. If its checksum no longer matches, the run stops: an applied
 *     migration must not change, because a database that ran the old version
 *     and a database that ran the new one would not be the same schema.
 *
 *  2. **The schema itself.** A database created by the old initdb mount has
 *     the whole schema and NO ledger. Those files were applied by Postgres
 *     itself, so the runner has to notice that on its own. It does so by
 *     looking for the OBJECTS each file creates — the tables, indexes, columns
 *     and policies it declares. If every object a file creates is already
 *     there, the file has been applied: it is recorded in the ledger and not
 *     executed. If SOME of them are there, the database is in a state no
 *     migration describes, and the run stops rather than guessing.
 *
 * A file that declares no objects at all (nothing this runner can look for)
 * is always executed — and must therefore be idempotent.
 */

/**
 * A thing a migration creates, used to tell whether the migration has already
 * been applied.
 */
export type MigrationMarker =
  | { readonly kind: 'table'; readonly name: string }
  | { readonly kind: 'index'; readonly name: string }
  | { readonly kind: 'column'; readonly table: string; readonly name: string }
  | { readonly kind: 'policy'; readonly table: string; readonly name: string }
  | { readonly kind: 'rls'; readonly table: string }
  | { readonly kind: 'extension'; readonly name: string };

/** A migration file, ready to be applied. */
export interface MigrationFile {
  /** The file name, e.g. `002_tenants_and_plans.sql`. */
  readonly name: string;
  /** The SQL to execute. */
  readonly sql: string;
  /** A digest of the SQL, used to detect an edited migration. */
  readonly checksum: string;
  /** The objects the file creates, used to detect an already-applied file. */
  readonly markers: readonly MigrationMarker[];
}

/** What the runner decided to do with one migration. */
export type MigrationOutcome =
  'applied' | 'already-applied' | 'baselined' | 'skipped';

/** The result of one run. */
export interface MigrationReport {
  readonly applied: readonly string[];
  readonly baselined: readonly string[];
  readonly skipped: readonly string[];
}

/** The subset of `pg` the runner needs; a fake satisfies it in tests. */
export interface MigrationClient {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Options for a run. */
export interface MigrationOptions {
  /**
   * Accept a migration whose contents changed after it was applied.
   *
   * Off by default: a changed migration means two databases with the same
   * version number and different schemas, which is the one thing a migration
   * ledger exists to prevent. It is useful while a migration is being written,
   * before it has been released.
   */
  readonly allowChecksumDrift?: boolean;
  /** Called with one line per decision, for the operator's console. */
  readonly log?: (message: string) => void;
}

/** The ledger table. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * The digest of a migration's contents.
 *
 * SHA-256 over the exact bytes: the point is to notice that the file changed,
 * not to have a meaningful hash function.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Finds the objects a migration creates.
 *
 * This is a deliberately small parser, not a SQL engine: it recognises the
 * handful of statements the migrations in this repository use to create
 * things. A statement it does not recognise simply produces no marker, which
 * means the file is treated as "always run" — safe, as long as such a file is
 * idempotent.
 */
export function parseMarkers(sql: string): MigrationMarker[] {
  const markers: MigrationMarker[] = [];
  let currentTable: string | null = null;

  const resetTable = (): void => {
    currentTable = null;
  };

  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('--')) {
      continue;
    }

    const table = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/i.exec(
      line,
    );
    if (table) {
      markers.push({ kind: 'table', name: unquote(table[1]) });
      resetTable();
      continue;
    }

    const index =
      /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/i.exec(
        line,
      );
    if (index) {
      markers.push({ kind: 'index', name: unquote(index[1]) });
      resetTable();
      continue;
    }

    const policy = /^CREATE\s+POLICY\s+([\w"]+)\s+ON\s+([\w"]+)/i.exec(line);
    if (policy) {
      markers.push({
        kind: 'policy',
        name: unquote(policy[1]),
        table: unquote(policy[2]),
      });
      resetTable();
      continue;
    }

    const extension =
      /^CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/i.exec(line);
    if (extension) {
      markers.push({ kind: 'extension', name: unquote(extension[1]) });
      resetTable();
      continue;
    }

    const alter =
      /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w"]+)/i.exec(line);
    if (alter) {
      currentTable = unquote(alter[1]);
      // The column may be on the same line (`ALTER TABLE t ADD COLUMN c ...`)
      // or on the lines that follow it.
      collectColumns(markers, currentTable, line.slice(alter[0].length));
      if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(line)) {
        markers.push({ kind: 'rls', table: currentTable });
      }
      continue;
    }

    if (currentTable !== null) {
      collectColumns(markers, currentTable, line);
      if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(line)) {
        markers.push({ kind: 'rls', table: currentTable });
      }
      // A new statement ends the ALTER the table belonged to.
      if (
        /^(CREATE|COMMENT|INSERT|UPDATE|DELETE|DO|GRANT|REVOKE|DROP)\b/i.test(
          line,
        )
      ) {
        resetTable();
      }
    }
  }

  return markers;
}

/** Collects the `ADD COLUMN` clauses of one ALTER statement. */
function collectColumns(
  markers: MigrationMarker[],
  table: string,
  text: string,
): void {
  const columns = text.matchAll(
    /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/gi,
  );
  for (const column of columns) {
    markers.push({ kind: 'column', table, name: unquote(column[1]) });
  }
}

/** Strips the quotes an identifier may carry in SQL. */
function unquote(identifier: string): string {
  return identifier.replace(/^"|"$/g, '').toLowerCase();
}

/**
 * Applies pending migrations.
 */
export class MigrationRunner {
  constructor(
    private readonly client: MigrationClient,
    private readonly options: MigrationOptions = {},
  ) {}

  /**
   * Brings the database up to the given migration set.
   *
   * Each migration runs in its own transaction: a migration that fails leaves
   * the database exactly as it was, and the run stops there rather than
   * continuing with a schema half-changed.
   */
  async run(files: readonly MigrationFile[]): Promise<MigrationReport> {
    const log = this.options.log ?? ((): void => undefined);

    await this.client.query(LEDGER_DDL);
    const ledger = await this.readLedger();

    const applied: string[] = [];
    const baselined: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const recorded = ledger.get(file.name);

      if (recorded !== undefined) {
        if (recorded !== file.checksum && !this.options.allowChecksumDrift) {
          throw new Error(
            `Migration ${file.name} has changed since it was applied ` +
              `(recorded ${recorded.slice(0, 12)}…, found ${file.checksum.slice(0, 12)}…). ` +
              'An applied migration must not change: write a new migration instead. ' +
              'Pass --allow-checksum-drift if this is a migration still in development.',
          );
        }
        if (recorded !== file.checksum) {
          await this.record(file.name, file.checksum);
        }
        skipped.push(file.name);
        continue;
      }

      const state = await this.stateOf(file);
      if (state === 'applied') {
        // The schema already has everything this file creates: it was applied
        // by the old initdb mount. Record it and move on.
        await this.record(file.name, file.checksum);
        baselined.push(file.name);
        log(`baseline  ${file.name} (already in the schema)`);
        continue;
      }
      if (state === 'partial') {
        throw new Error(
          `Migration ${file.name} is only partly applied: some of the objects it ` +
            'creates exist and others do not. The database is in a state no ' +
            'migration describes, so the run stops here.',
        );
      }

      await this.apply(file);
      applied.push(file.name);
      log(`applied   ${file.name}`);
    }

    if (applied.length === 0 && baselined.length === 0) {
      log('The schema is already up to date.');
    }

    return { applied, baselined, skipped };
  }

  /** The recorded migrations, by file name. */
  private async readLedger(): Promise<Map<string, string>> {
    const result = await this.client.query(
      'SELECT filename, checksum FROM schema_migrations',
    );
    return new Map(
      result.rows.map(
        (row) => [String(row.filename), String(row.checksum)] as const,
      ),
    );
  }

  /** Writes one row of the ledger. */
  private async record(filename: string, checksum: string): Promise<void> {
    await this.client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
      [filename, checksum],
    );
  }

  /**
   * Whether the objects a file creates are already in the database.
   *
   * `applied` — all of them are there.
   * `partial` — some of them are there.
   * `pending` — none of them are there (or the file declares none).
   */
  private async stateOf(
    file: MigrationFile,
  ): Promise<'applied' | 'partial' | 'pending'> {
    if (file.markers.length === 0) {
      return 'pending';
    }

    let present = 0;
    for (const marker of file.markers) {
      if (await this.markerExists(marker)) {
        present += 1;
      }
    }

    if (present === file.markers.length) {
      return 'applied';
    }
    return present === 0 ? 'pending' : 'partial';
  }

  /** Whether one marker is in the database. */
  private async markerExists(marker: MigrationMarker): Promise<boolean> {
    const exists = async (
      sql: string,
      values: readonly unknown[],
    ): Promise<boolean> => {
      const result = await this.client.query(sql, values);
      return result.rows[0]?.exists === true;
    };

    switch (marker.kind) {
      case 'table':
        return exists(
          `SELECT EXISTS (
             SELECT 1 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = $1
                AND c.relkind IN ('r', 'p')) AS exists`,
          [marker.name],
        );
      case 'index':
        return exists(
          `SELECT EXISTS (
             SELECT 1 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = $1
                AND c.relkind = 'i') AS exists`,
          [marker.name],
        );
      case 'column':
        return exists(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = $1
                AND column_name = $2) AS exists`,
          [marker.table, marker.name],
        );
      case 'policy':
        return exists(
          `SELECT EXISTS (
             SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename = $1
                AND policyname = $2) AS exists`,
          [marker.table, marker.name],
        );
      case 'rls':
        return exists(
          `SELECT EXISTS (
             SELECT 1 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = $1
                AND c.relrowsecurity) AS exists`,
          [marker.table],
        );
      case 'extension':
        return exists(
          'SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists',
          [marker.name],
        );
    }
  }

  /** Runs one migration in a transaction, and records it. */
  private async apply(file: MigrationFile): Promise<void> {
    await this.client.query('BEGIN');
    try {
      await this.client.query(file.sql);
      await this.record(file.name, file.checksum);
      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw new Error(
        `Migration ${file.name} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}
