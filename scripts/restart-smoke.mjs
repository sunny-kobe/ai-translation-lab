import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import assert from 'node:assert/strict';
const url =
  process.env.DATABASE_URL ||
  'postgresql://translation_lab:translation_lab_local@127.0.0.1:54329/translation_lab';
if (!/\/translation_lab(?:_test)?$/.test(new URL(url).pathname))
  throw new Error('Project-only database required');
const schema = `restart_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({ connectionString: url });
const scoped = new URL(url);
scoped.searchParams.set('options', `-c search_path=${schema}`);
const port = 4311;
let child;
let output = '';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: scoped.href,
      PORT: String(port),
      TRANSLATOR_PROVIDER: 'fake',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null)
      throw new Error(`Test server failed: ${output.slice(-1000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await pause(100);
  }
  throw new Error('Restart smoke server did not start');
}
async function stop(signal) {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill(signal);
    await exited;
  }
}
try {
  // Do not risk terminating another process or using its endpoint.
  const { createServer } = await import('node:net');
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await start();
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: Array.from({ length: 8 }, (_, i) => ({
        key: `crash.${i}`,
        text: 'Hello {name}',
      })),
      languages: ['zh', 'fr'],
    }),
  });
  assert.equal(res.status, 202);
  const job = await res.json();
  let interrupted;
  for (let i = 0; i < 100; i++) {
    const rows = await pool.query(
      `SELECT id,attempts FROM ${schema}.translation_results WHERE job_id=$1 AND status='running'`,
      [job.id],
    );
    if (rows.rows[0]) {
      interrupted = rows.rows[0];
      break;
    }
    await pause(10);
  }
  assert.ok(interrupted, 'A provider attempt was running before the crash');
  await stop('SIGKILL');
  await start();
  let state;
  for (let i = 0; i < 150; i++) {
    state = await (
      await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}`)
    ).json();
    if (state.status === 'succeeded') break;
    await pause(100);
  }
  assert.equal(state.status, 'succeeded');
  assert.equal(state.completed, 16);
  const saved = await pool.query(
    `SELECT attempts,status FROM ${schema}.translation_results WHERE id=$1`,
    [interrupted.id],
  );
  assert.ok(saved.rows[0].attempts >= 2);
  assert.equal(saved.rows[0].status, 'succeeded');
  await mkdir('output', { recursive: true });
  await writeFile(
    'output/restart-smoke.json',
    JSON.stringify(
      {
        passed: true,
        simulatedCrash: 'SIGKILL of this script-owned API process',
        recoveredResults: state.completed,
        interruptedResultAttempts: saved.rows[0].attempts,
      },
      null,
      2,
    ),
  );
  console.log(
    'Restart smoke passed: actual process crash, persistent task recovered, 16/16 results complete.',
  );
} finally {
  await stop('SIGTERM');
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
  await mkdir('output', { recursive: true });
  await writeFile('output/restart-smoke.log', output);
}
