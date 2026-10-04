import 'dotenv/config';
import pg from 'pg';
export const localDatabaseUrl =
  'postgresql://translation_lab:translation_lab_local@127.0.0.1:54329/translation_lab';
export function createPool(url = process.env.DATABASE_URL || localDatabaseUrl) {
  const target = new URL(url);
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    !/^\/translation_lab(?:_test)?$/.test(target.pathname)
  )
    throw new Error(
      'V1 requires the project-specific local PostgreSQL database',
    );
  return new pg.Pool({
    connectionString: url,
    max: 6,
    connectionTimeoutMillis: 5000,
  });
}
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
