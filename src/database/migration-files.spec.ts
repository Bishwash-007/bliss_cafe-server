import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksumOf } from './migration-runner';
import { readMigrations, resolveMigrationsDir } from './migration-files';

describe('readMigrations', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'migrations-'));
  });

  it('reads the files in name order, with their checksum and markers', async () => {
    await writeFile(
      join(directory, '002_second.sql'),
      'CREATE TABLE second_table (id UUID);',
      'utf8',
    );
    await writeFile(
      join(directory, '001_first.sql'),
      'CREATE TABLE first_table (id UUID);',
      'utf8',
    );

    const files = await readMigrations(directory);

    expect(files.map((file) => file.name)).toEqual([
      '001_first.sql',
      '002_second.sql',
    ]);
    expect(files[0]?.checksum).toBe(
      checksumOf('CREATE TABLE first_table (id UUID);'),
    );
    expect(files[0]?.markers).toEqual([{ kind: 'table', name: 'first_table' }]);
  });

  it('ignores files that are not migrations', async () => {
    await writeFile(join(directory, '001_first.sql'), 'SELECT 1;', 'utf8');
    await writeFile(join(directory, 'README.md'), '# not a migration', 'utf8');

    const files = await readMigrations(directory);

    expect(files.map((file) => file.name)).toEqual(['001_first.sql']);
  });

  it('reads an empty directory as no migrations', async () => {
    await mkdir(join(directory, 'nested'), { recursive: true });

    await expect(readMigrations(directory)).resolves.toEqual([]);
  });
});

describe('resolveMigrationsDir', () => {
  it('finds the migrations of this repository', () => {
    // The runner must find db/migrations from the source tree and from the
    // compiled build; both walk up to the project root.
    const resolved = resolveMigrationsDir();
    expect(resolved.endsWith(join('db', 'migrations'))).toBe(true);
  });
});
