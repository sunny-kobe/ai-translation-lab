import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool, transaction } from './db';
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(4310001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const root = new URL('../sql/', import.meta.url);
    for (const name of (await readdir(root))
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort()) {
      const applied = await client.query(
        'SELECT name FROM schema_migrations WHERE name=$1',
        [name],
      );
      if (applied.rowCount) continue;
      await client.query(await readFile(new URL(name, root), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [
        name,
      ]);
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try {
    await migrate(pool);
    console.log('Migrations applied');
  } finally {
    await pool.end();
  }
}
