import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
const dir = new URL('../.local/postgres/', import.meta.url).pathname;
const port = 54329;
await new Promise<void>((resolve, reject) => {
  const server = createServer();
  server.once('error', () =>
    reject(
      new Error(
        `Port ${port} is occupied; do not start or stop another instance.`,
      ),
    ),
  );
  server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
});
await mkdir(dir, { recursive: true });
const db = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'translation_lab',
  password: 'translation_lab_local',
  port,
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: (message) => console.error(message),
});
try {
  await access(`${dir}/PG_VERSION`);
} catch {
  await db.initialise();
}
await db.start();
const client = db.getPgClient();
await client.connect();
const exists = await client.query(
  "SELECT 1 FROM pg_database WHERE datname='translation_lab'",
);
if (!exists.rowCount) await client.query('CREATE DATABASE translation_lab');
await client.end();
console.log(
  'Project PostgreSQL ready on 127.0.0.1:54329; data in .local/postgres (persistent).',
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await db.stop();
    process.exit(0);
  });
setInterval(() => {}, 30000);
