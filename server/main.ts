import { createPool } from './db';
import { migrate } from './migrate';
import { buildApp } from './app';
import { createProvider, ZhipuTranslator } from './providers';
import { Worker } from './worker';
const provider = createProvider();
const pool = createPool();
await migrate(pool);
const app = await buildApp(pool, true, {
  name: provider instanceof ZhipuTranslator ? 'zhipu' : 'fake',
  model: provider instanceof ZhipuTranslator ? provider.model : null,
  promptVersion: provider.snapshot?.promptVersion || 'unknown',
});
const worker = new Worker(pool, provider, app.log);
try {
  await worker.initialize();
  await app.listen({
    port: Number(process.env.PORT || 4310),
    host: '127.0.0.1',
  });
  worker.start();
} catch (error) {
  await app.close();
  await worker.close();
  await pool.end();
  throw error;
}
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await worker.close();
    await pool.end();
    process.exit(0);
  });
