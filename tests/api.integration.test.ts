import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { api as browserApi } from '../web/api';
import { createPool } from '../server/db';
import { migrate } from '../server/migrate';
import { buildApp } from '../server/app';
import { Worker } from '../server/worker';
import { FakeTranslator, type TranslatorProvider } from '../server/providers';
import { QualityError } from '../server/quality';
import { languageOptions } from '../shared/languages';
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = createPool();
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let worker: Worker;
const input = {
  entries: [{ key: 'hello', text: 'Hello {name}, Nova' }],
  languages: ['zh', 'fr'],
  glossary: [{ source: 'Nova', targets: { zh: 'Nova', fr: 'Nova' } }],
};
async function create(scenario = 'normal') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { ...input, scenario },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}
async function items(id: string) {
  return (await app.inject({ url: `/api/jobs/${id}/items` })).json() as Array<{
    id: string;
    language: string;
    source_key: string;
    source_text: string;
    revision: number;
    target_text: string;
    status: string;
    approved: boolean;
    human_edited: boolean;
    attempts: number;
  }>;
}
async function drain(id: string) {
  for (let i = 0; i < 20; i++) {
    if (!(await worker.runOnce())) break;
  }
  return (await app.inject({ url: `/api/jobs/${id}` })).json();
}
beforeAll(async () => {
  if (
    !/\/translation_lab(?:_test)?$/.test(
      new URL(
        process.env.DATABASE_URL ||
          'postgresql://translation_lab:translation_lab_local@127.0.0.1:54329/translation_lab',
      ).pathname,
    )
  )
    throw new Error('Integration tests require the project-specific database');
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://translation_lab:translation_lab_local@127.0.0.1:54329/translation_lab',
    options: `-c search_path=${schema}`,
  });
  await migrate(pool);
  await migrate(pool);
  app = await buildApp(pool, false);
  await app.ready();
  worker = new Worker(pool, new FakeTranslator(), app.log);
  await worker.initialize();
});
afterAll(async () => {
  if (worker) await worker.close();
  if (app) await app.close();
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});
describe('PostgreSQL + Fastify + worker', () => {
  it('reports the provider actually configured for this app instance', async () => {
    const res = await app.inject({ url: '/api/health' });
    expect(res.json()).toEqual({ status: 'ok', provider: 'fake', model: null });
  });
  it('enforces runtime API input and duplicate keys', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/jobs',
          payload: { ...input, languages: ['unknown'] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/jobs',
          payload: { ...input, entries: [input.entries[0], input.entries[0]] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/jobs',
          payload: { ...input, entries: [{ key: 'hello', text: '   ' }] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/jobs',
          payload: { ...input, languages: [] },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('persists asynchronous jobs, retries invalid model output and exports only approved language', async () => {
    const id = await create('malformed');
    const job = await drain(id);
    expect(job.status).toBe('succeeded');
    expect(job.completed).toBe(2);
    const rows = await items(id);
    expect(rows.every((r) => r.attempts === 2)).toBe(true);
    expect(
      (await app.inject({ url: `/api/jobs/${id}/export/zh` })).statusCode,
    ).toBe(409);
    const zh = rows.find((r) => r.language === 'zh')!;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${id}/items/${zh.id}`,
          payload: {
            text: zh.target_text,
            approved: true,
            revision: zh.revision,
          },
        })
      ).statusCode,
    ).toBe(200);
    const res = await app.inject({ url: `/api/jobs/${id}/export/zh` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: zh.target_text });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${id}/items/${zh.id}`,
          payload: {
            text: 'stale {name} Nova',
            approved: true,
            revision: zh.revision,
          },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('reports partial success and preserves human edits during retry', async () => {
    const id = await create('partial');
    expect((await drain(id)).status).toBe('partial');
    const rows = await items(id);
    const zh = rows.find((r) => r.language === 'zh')!;
    const fr = rows.find((r) => r.language === 'fr')!;
    expect(fr.attempts).toBe(3);
    const attempts = await pool.query(
      'SELECT attempt FROM translation_attempts WHERE result_id=$1 ORDER BY id',
      [fr.id],
    );
    expect(attempts.rows.map((row) => row.attempt)).toEqual([1, 2, 3]);
    await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${id}/items/${zh.id}`,
      payload: {
        text: '人工内容 {name} Nova',
        approved: true,
        revision: zh.revision,
      },
    });
    expect(
      (await app.inject({ method: 'POST', url: `/api/jobs/${id}/retry` }))
        .statusCode,
    ).toBe(200);
    await drain(id);
    const saved = (await items(id)).find((r) => r.language === 'zh')!;
    expect(saved.target_text).toBe('人工内容 {name} Nova');
    expect(saved.approved).toBe(true);
    expect(saved.human_edited).toBe(true);
  });
  it('rejects invalid human text too', async () => {
    const id = await create();
    await drain(id);
    const row = (await items(id))[0];
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${id}/items/${row.id}`,
      payload: {
        text: 'missing placeholder',
        approved: true,
        revision: row.revision,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe('PLACEHOLDER_MISMATCH');
  });
  it('recovers running rows on worker restart and excludes a second worker', async () => {
    const id = await create();
    await pool.query(
      "UPDATE translation_results SET status='running',attempts=1,revision=1 WHERE job_id=$1",
      [id],
    );
    const duplicate = new Worker(pool, new FakeTranslator(), app.log);
    await expect(duplicate.initialize()).rejects.toThrow(
      'WORKER_ALREADY_RUNNING',
    );
    await duplicate.close();
    await worker.close();
    worker = new Worker(pool, new FakeTranslator(), app.log);
    await worker.initialize();
    expect((await items(id)).every((r) => r.status === 'queued')).toBe(true);
    expect((await drain(id)).status).toBe('succeeded');
  });
  it('discards a late provider result after a manual edit', async () => {
    const id = await create();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: TranslatorProvider = {
      translate: async (request) => {
        entered();
        await blocked;
        return {
          key: request.key,
          language: request.language,
          text: 'old {name} Nova',
        };
      },
    };
    await worker.close();
    worker = new Worker(pool, provider, app.log);
    await worker.initialize();
    const running = worker.runOnce();
    await started;
    const row = (await items(id)).find((r) => r.status === 'running')!;
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${id}/items/${row.id}`,
      payload: {
        text: 'manual {name} Nova',
        approved: true,
        revision: row.revision,
      },
    });
    expect(edit.statusCode).toBe(200);
    release();
    await running;
    const saved = (await items(id)).find((r) => r.id === row.id)!;
    expect(saved.target_text).toBe('manual {name} Nova');
    expect(saved.approved).toBe(true);
    const history = await pool.query(
      'SELECT outcome FROM translation_attempts WHERE result_id=$1',
      [row.id],
    );
    expect(history.rows[0].outcome).toBe('discarded');
    await worker.close();
    worker = new Worker(pool, new FakeTranslator(), app.log);
    await worker.initialize();
    await drain(id);
  });
  it('sends the browser retry request through a real HTTP server', async () => {
    const id = await create('partial');
    await drain(id);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      originalFetch(new URL(path, address), init),
    );
    try {
      expect((await browserApi.retry(id)).status).toBe('running');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('returns 400 for invalid JSON and empty JSON bodies', async () => {
    for (const payload of ['', '{not-json']) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { 'Content-Type': 'application/json' },
        payload,
      });
      expect(result.statusCode).toBe(400);
    }
  });
  it('publishes OpenAPI for the actual routes', async () => {
    const res = await app.inject({ url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths['/api/jobs']).toBeDefined();
  });
  it('keeps all 50 keys × 50 languages distinct and exports exactly one reviewed language', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      key: `matrix.key${index}`,
      text: `Hello {name}, Nova ${index}!`,
    }));
    const languages = languageOptions.map((language) => language.value);
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { entries, languages },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    // The suite may still have queued failures from the browser retry case.
    for (let turn = 0; turn < 700; turn++) {
      if (!(await worker.runOnce())) break;
    }
    const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
    expect(job).toMatchObject({
      status: 'succeeded',
      total: 2500,
      completed: 2500,
      failed: 0,
      approved: 0,
    });
    const rows = await items(id);
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2500);
    const exported: Record<string, string> = {};
    for (const language of languages) {
      const localized = rows.filter((row) => row.language === language);
      expect(localized).toHaveLength(50);
      for (const entry of entries) {
        const matching = localized.filter(
          (row) => row.source_key === entry.key,
        );
        expect(matching).toHaveLength(1);
        expect(matching[0].source_text).toBe(entry.text);
        expect(matching[0].target_text).toBe(
          `[模拟/${language}] ${entry.text}`,
        );
      }
      expect(
        (await app.inject({ url: `/api/jobs/${id}/export/${language}` }))
          .statusCode,
      ).toBe(409);
      if (language !== 'zh') continue;
      for (const row of localized) {
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/api/jobs/${id}/items/${row.id}`,
              payload: {
                text: row.target_text,
                approved: true,
                revision: row.revision,
              },
            })
          ).statusCode,
        ).toBe(200);
        exported[row.source_key] = row.target_text;
      }
    }
    const download = await app.inject({ url: `/api/jobs/${id}/export/zh` });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toEqual(exported);
    expect(Object.keys(download.json())).toHaveLength(50);
    const saved = await items(id);
    expect(saved.filter((row) => row.approved)).toHaveLength(50);
    expect(
      saved.filter((row) => row.approved).every((row) => row.language === 'zh'),
    ).toBe(true);
    const calls = await pool.query(
      'SELECT count(*)::int AS count FROM translation_calls WHERE job_id=$1',
      [id],
    );
    expect(calls.rows[0].count).toBe(50);
  }, 45000);
  it('limits key-level model requests to configured concurrency', async () => {
    await worker.close();
    const fake = new FakeTranslator();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const provider: TranslatorProvider = {
      translate: fake.translate.bind(fake),
      translateKey: async (request, signal) => {
        active += 1;
        peak = Math.max(peak, active);
        calls += 1;
        try {
          return await fake.translateKey!(request, signal);
        } finally {
          active -= 1;
        }
      },
      snapshot: fake.snapshot,
    };
    worker = new Worker(pool, provider, app.log);
    await worker.initialize();
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        entries: Array.from({ length: 4 }, (_, index) => ({
          key: `concurrency.key${index}`,
          text: 'Hello {name}',
        })),
        languages: languageOptions.map((language) => language.value),
      },
    });
    const id = res.json().id as string;
    worker.start();
    for (let i = 0; i < 100; i++) {
      const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
      if (job.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await worker.close();
    expect(calls).toBe(4);
    expect(peak).toBe(2);
    expect((await app.inject({ url: `/api/jobs/${id}` })).json()).toMatchObject(
      {
        status: 'succeeded',
        total: 200,
        completed: 200,
      },
    );
  }, 30000);
  it('records a permanent provider failure once without automatic retries', async () => {
    while (await worker.runOnce()) {
      // Finish earlier scenarios before switching the suite's worker provider.
    }
    await worker.close();
    const translate = vi
      .fn<TranslatorProvider['translate']>()
      .mockRejectedValue(new QualityError('PROVIDER_AUTH_ERROR', false));
    worker = new Worker(pool, { translate }, app.log);
    await worker.initialize();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...input, languages: ['zh'] },
      });
      const id = res.json().id;
      expect((await drain(id)).status).toBe('failed');
      const rows = await items(id);
      expect(rows[0].attempts).toBe(1);
      expect(translate).toHaveBeenCalledTimes(1);
      const history = await pool.query(
        'SELECT error_code FROM translation_attempts WHERE result_id=$1',
        [rows[0].id],
      );
      expect(history.rows).toEqual([{ error_code: 'PROVIDER_AUTH_ERROR' }]);
    } finally {
      await worker.close();
      worker = new Worker(pool, new FakeTranslator(), app.log);
      await worker.initialize();
    }
  });
});
