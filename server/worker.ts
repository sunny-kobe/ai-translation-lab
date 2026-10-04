import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { KeyTranslateInput, ResultRow } from '../shared/contracts';
import { transaction } from './db';
import { refreshJob } from './store';
import { QualityError, validateKeyTranslation } from './quality';
import type { TranslatorProvider } from './providers';

export class Worker {
  private lease?: pg.PoolClient;
  private stopped = false;
  private loopPromise?: Promise<void>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly concurrency: number;
  constructor(
    private pool: pg.Pool,
    private provider: TranslatorProvider,
    private log: FastifyBaseLogger,
  ) {
    const configured = Number(process.env.TRANSLATOR_CONCURRENCY || 2);
    this.concurrency = Number.isInteger(configured)
      ? Math.max(1, Math.min(4, configured))
      : 2;
  }
  async initialize() {
    this.lease = await this.pool.connect();
    const lock = await this.lease.query(
      'SELECT pg_try_advisory_lock(hashtext(current_schema()),4310002) AS acquired',
    );
    if (!lock.rows[0].acquired) {
      this.lease.release();
      this.lease = undefined;
      throw new Error('WORKER_ALREADY_RUNNING');
    }
    this.lease.on('error', () => {
      this.stopped = true;
      this.log.error({ code: 'WORKER_LEASE_LOST' }, 'Worker stopped');
    });
    await this.recoverInterrupted();
  }
  private async recoverInterrupted() {
    await transaction(this.pool, async (client) => {
      const jobs = await client.query(
        "SELECT j.id FROM translation_jobs j WHERE EXISTS (SELECT 1 FROM translation_results r WHERE r.job_id=j.id AND r.status='running') FOR UPDATE",
      );
      for (const { id } of jobs.rows) {
        await client.query(
          "UPDATE translation_results SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_code=CASE WHEN attempts>=3 THEN 'WORKER_INTERRUPTED' ELSE NULL END,next_attempt_at=now(),revision=revision+1 WHERE job_id=$1 AND status='running' AND NOT human_edited AND NOT approved",
          [id],
        );
        await refreshJob(client, id);
      }
    });
  }
  private async claimKey() {
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<{
        job_id: string;
        source_key: string;
      }>(
        `SELECT r.job_id,r.source_key FROM translation_results r JOIN translation_jobs j ON j.id=r.job_id
         WHERE r.status='queued' AND r.next_attempt_at<=now() AND NOT EXISTS(SELECT 1 FROM translation_results x WHERE x.job_id=r.job_id AND x.source_key=r.source_key AND x.status='running')
         ORDER BY j.created_at,r.source_key LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
      );
      const candidate = candidates.rows[0];
      if (!candidate) return null;
      const job = (
        await client.query(
          'SELECT * FROM translation_jobs WHERE id=$1 FOR UPDATE',
          [candidate.job_id],
        )
      ).rows[0];
      const results = (
        await client.query<ResultRow>(
          "SELECT * FROM translation_results WHERE job_id=$1 AND source_key=$2 AND status='queued' AND next_attempt_at<=now() AND NOT human_edited AND NOT approved FOR UPDATE",
          [candidate.job_id, candidate.source_key],
        )
      ).rows;
      if (!results.length) return null;
      const callId = randomUUID();
      const snapshot = this.provider.snapshot;
      await client.query(
        'INSERT INTO translation_calls(id,job_id,source_key,provider,model,prompt_version,languages) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          callId,
          job.id,
          candidate.source_key,
          snapshot?.name || 'unknown',
          snapshot?.model || null,
          snapshot?.promptVersion || 'unknown',
          JSON.stringify(results.map((r) => r.language)),
        ],
      );
      for (const row of results) {
        await client.query(
          "UPDATE translation_results SET status='running',attempts=attempts+1,revision=revision+1,call_id=$2,updated_at=now() WHERE id=$1",
          [row.id, callId],
        );
      }
      await refreshJob(client, job.id);
      return { job, results, callId };
    });
  }
  private async execute(
    claimed: NonNullable<Awaited<ReturnType<Worker['claimKey']>>>,
  ) {
    const { job, results, callId } = claimed;
    const input: KeyTranslateInput = {
      key: results[0].source_key,
      text: results[0].source_text,
      languages: results.map((r) => r.language),
      glossary: job.glossary,
      attempts: Object.fromEntries(
        results.map((r) => [r.language, r.attempts + 1]),
      ),
      scenario: job.fake_scenario,
    };
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(),
      this.provider.timeoutMs || 60000,
    );
    const started = performance.now();
    let validated:
      | Map<string, { text: string | null; error: QualityError | null }>
      | undefined;
    let code: string | null = null;
    let retryAfterMs = 0;
    let usage = null;
    try {
      let reply;
      if (this.provider.translateKey)
        reply = await Promise.race([
          this.provider.translateKey(input, abort.signal),
          new Promise<never>((_, reject) =>
            abort.signal.addEventListener(
              'abort',
              () => reject(new QualityError('PROVIDER_TIMEOUT')),
              { once: true },
            ),
          ),
        ]);
      else if (this.provider.translate) {
        const translations = [];
        for (const row of results)
          translations.push({
            language: row.language,
            text: await this.provider.translate(
              { ...input, language: row.language, attempt: row.attempts + 1 },
              abort.signal,
            ),
          });
        reply = { output: { key: input.key, translations }, usage: null };
      } else throw new QualityError('PROVIDER_ERROR', false);
      usage = reply.usage;
      validated = validateKeyTranslation(input, reply.output);
    } catch (error) {
      code = error instanceof QualityError ? error.code : 'PROVIDER_ERROR';
      retryAfterMs = error instanceof QualityError ? error.retryAfterMs : 0;
      if (error instanceof QualityError) usage = error.usage;
    }
    clearTimeout(timeout);
    await transaction(this.pool, async (client) => {
      await client.query(
        'SELECT id FROM translation_jobs WHERE id=$1 FOR UPDATE',
        [job.id],
      );
      for (const row of results) {
        const item = validated?.get(row.language);
        const itemCode =
          item?.error?.code ||
          (code &&
          (code === 'OUTPUT_SCHEMA' ||
            code === 'KEY_MISMATCH' ||
            code === 'LANGUAGE_DUPLICATE')
            ? code
            : null);
        const retryable =
          item?.error?.retryable ??
          (!code ||
            ![
              'PROVIDER_AUTH_ERROR',
              'PROVIDER_BALANCE_ERROR',
              'PROVIDER_REQUEST_ERROR',
              'OUTPUT_TRUNCATED',
            ].includes(code));
        const next = item?.text
          ? 'succeeded'
          : row.attempts >= 3 || !retryable
            ? 'failed'
            : 'queued';
        const delay =
          retryable && next === 'queued'
            ? Math.min(
                60000,
                (retryAfterMs || this.provider.retryDelayMs || 0) *
                  2 ** Math.max(0, row.attempts - 1),
              )
            : 0;
        const updated = await client.query(
          `UPDATE translation_results SET status=$3,target_text=$4,error_code=$5,next_attempt_at=now()+($6 * interval '1 millisecond'),revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND status='running' AND NOT human_edited AND NOT approved`,
          [
            row.id,
            row.revision + 1,
            next,
            item?.text || null,
            itemCode || code,
            delay,
          ],
        );
        await client.query(
          'INSERT INTO translation_attempts(result_id,attempt,outcome,error_code,duration_ms,call_id) VALUES($1,$2,$3,$4,$5,$6)',
          [
            row.id,
            row.attempts,
            updated.rowCount
              ? next === 'succeeded'
                ? 'succeeded'
                : 'failed'
              : 'discarded',
            itemCode || code,
            Math.round(performance.now() - started),
            callId,
          ],
        );
      }
      await client.query(
        'UPDATE translation_calls SET status=$2,usage=$3,duration_ms=$4,finished_at=now(),error_code=$5 WHERE id=$1',
        [
          callId,
          validated && [...validated.values()].every((v) => v.text)
            ? 'succeeded'
            : validated
              ? 'partial'
              : 'failed',
          usage ? JSON.stringify(usage) : null,
          Math.round(performance.now() - started),
          code,
        ],
      );
      await refreshJob(client, job.id);
    });
  }
  private launch(
    claimed: NonNullable<Awaited<ReturnType<Worker['claimKey']>>>,
  ) {
    const key = `${claimed.job.id}:${claimed.results[0].source_key}`;
    const task = this.execute(claimed)
      .catch((error) =>
        this.log.error({ err: error, key }, 'Key translation failed'),
      )
      .finally(() => this.active.delete(key));
    this.active.set(key, task);
    return task;
  }
  async runOnce() {
    if (!this.lease || this.stopped || this.active.size >= this.concurrency)
      return false;
    const claimed = await this.claimKey();
    if (!claimed) return false;
    await this.launch(claimed);
    return true;
  }
  start() {
    this.loopPromise = (async () => {
      while (!this.stopped) {
        while (this.active.size < this.concurrency && !this.stopped) {
          const claimed = await this.claimKey();
          if (!claimed) break;
          this.launch(claimed);
        }
        if (this.active.size) await Promise.race(this.active.values());
        else await new Promise((r) => setTimeout(r, 200));
      }
    })();
  }
  async close() {
    this.stopped = true;
    await this.loopPromise;
    await Promise.all(this.active.values());
    if (this.lease) {
      await this.lease.query(
        'SELECT pg_advisory_unlock(hashtext(current_schema()),4310002)',
      );
      this.lease.release();
      this.lease = undefined;
    }
  }
}
