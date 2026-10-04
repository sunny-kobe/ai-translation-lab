import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  JobInput,
  JobRow,
  ResultRow,
  TranslateInput,
} from '../shared/contracts';
import { transaction } from './db';
import { aggregateStatus, validateTranslation } from './quality';
import type { ProviderSnapshot } from '../shared/contracts';
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const jobSelect = `SELECT j.*, count(r.id)::int AS total,
 count(r.id) FILTER(WHERE r.status IN ('succeeded','failed'))::int AS completed,
 count(r.id) FILTER(WHERE r.status='failed')::int AS failed,
 count(r.id) FILTER(WHERE r.approved)::int AS approved
 FROM translation_jobs j JOIN translation_results r ON r.job_id=j.id`;
export async function refreshJob(client: pg.PoolClient, id: string) {
  const { rows } = await client.query<{ status: ResultRow['status'] }>(
    'SELECT status FROM translation_results WHERE job_id=$1',
    [id],
  );
  await client.query(
    'UPDATE translation_jobs SET status=$2,updated_at=now() WHERE id=$1',
    [id, aggregateStatus(rows.map((r) => r.status))],
  );
}
export class Store {
  constructor(
    public pool: pg.Pool,
    private snapshot: ProviderSnapshot = {
      name: 'fake',
      model: null,
      promptVersion: 'unknown',
    },
  ) {}
  async create(input: JobInput) {
    if (new Set(input.entries.map((e) => e.key)).size !== input.entries.length)
      throw new ApiError(400, 'Duplicate source keys');
    // ICU plural/select and arbitrary HTML are deliberately outside the V1 contract.
    if (
      input.entries.some((e) =>
        /\{[^{}]*,\s*(plural|select|selectordinal)\b/.test(e.text),
      )
    )
      throw new ApiError(
        400,
        'ICU plural/select is outside V1; use simple placeholders',
      );
    const id = randomUUID();
    await transaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO translation_jobs(id,languages,glossary,fake_scenario,provider,model,prompt_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          JSON.stringify(input.languages),
          JSON.stringify(input.glossary || []),
          input.scenario || 'normal',
          this.snapshot.name,
          this.snapshot.model,
          this.snapshot.promptVersion,
        ],
      );
      for (const entry of input.entries)
        for (const lang of input.languages)
          await client.query(
            'INSERT INTO translation_results(id,job_id,source_key,source_text,language) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), id, entry.key, entry.text, lang],
          );
    });
    return this.job(id);
  }
  async list(): Promise<JobRow[]> {
    const { rows } = await this.pool.query(
      `${jobSelect} GROUP BY j.id ORDER BY j.created_at DESC LIMIT 50`,
    );
    return rows.map(serializeJob);
  }
  async job(id: string): Promise<JobRow> {
    const { rows } = await this.pool.query(
      `${jobSelect} WHERE j.id=$1 GROUP BY j.id`,
      [id],
    );
    if (!rows[0]) throw new ApiError(404, 'Job not found');
    return serializeJob(rows[0]);
  }
  async items(id: string): Promise<ResultRow[]> {
    await this.job(id);
    const { rows } = await this.pool.query(
      'SELECT * FROM translation_results WHERE job_id=$1 ORDER BY source_key,language',
      [id],
    );
    return rows;
  }
  async edit(
    id: string,
    itemId: string,
    body: { text: string; approved: boolean; revision: number },
  ): Promise<ResultRow> {
    return transaction(this.pool, async (client) => {
      // All job mutations take the same row lock to avoid aggregate-state races.
      const { rows: jobs } = await client.query(
        'SELECT * FROM translation_jobs WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!jobs[0]) throw new ApiError(404, 'Job not found');
      const { rows } = await client.query<ResultRow>(
        'SELECT * FROM translation_results WHERE id=$1 AND job_id=$2 FOR UPDATE',
        [itemId, id],
      );
      const item = rows[0];
      if (!item) throw new ApiError(404, 'Result not found');
      if (item.revision !== body.revision)
        throw new ApiError(409, 'Result changed. Refresh before editing.');
      const input: TranslateInput = {
        key: item.source_key,
        text: item.source_text,
        language: item.language as TranslateInput['language'],
        glossary: jobs[0].glossary,
        attempt: Math.max(item.attempts, 1),
        scenario: 'normal',
      };
      validateTranslation(input, {
        key: item.source_key,
        language: item.language,
        text: body.text,
      });
      const humanEdited = item.human_edited || item.target_text !== body.text;
      const { rows: updated } = await client.query<ResultRow>(
        `UPDATE translation_results SET target_text=$3,approved=$4,human_edited=$5,status='succeeded',error_code=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND job_id=$2 RETURNING *`,
        [itemId, id, body.text, body.approved, humanEdited],
      );
      await refreshJob(client, id);
      return updated[0];
    });
  }
  async retry(id: string) {
    await transaction(this.pool, async (client) => {
      const job = await client.query(
        'SELECT id FROM translation_jobs WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!job.rowCount) throw new ApiError(404, 'Job not found');
      await client.query(
        `UPDATE translation_results SET status='queued',attempts=0,error_code=NULL,next_attempt_at=now(),revision=revision+1,updated_at=now() WHERE job_id=$1 AND status='failed' AND NOT human_edited AND NOT approved`,
        [id],
      );
      await refreshJob(client, id);
    });
    return this.job(id);
  }
  async export(id: string, lang: string) {
    return transaction(this.pool, async (client) => {
      const { rows: jobs } = await client.query(
        'SELECT * FROM translation_jobs WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!jobs[0]) throw new ApiError(404, 'Job not found');
      if (!jobs[0].languages.includes(lang))
        throw new ApiError(400, 'Language is not part of this job');
      const { rows } = await client.query<ResultRow>(
        'SELECT * FROM translation_results WHERE job_id=$1 AND language=$2 ORDER BY source_key',
        [id, lang],
      );
      if (
        rows.some(
          (r) => r.status !== 'succeeded' || !r.approved || !r.target_text,
        )
      )
        throw new ApiError(
          409,
          'All results for this language must be successful and approved before export',
        );
      for (const r of rows)
        validateTranslation(
          {
            key: r.source_key,
            text: r.source_text,
            language: lang as TranslateInput['language'],
            glossary: jobs[0].glossary,
            attempt: 1,
            scenario: 'normal',
          },
          { key: r.source_key, language: lang, text: r.target_text },
        );
      return Object.fromEntries(rows.map((r) => [r.source_key, r.target_text]));
    });
  }
}
function serializeJob(row: JobRow): JobRow {
  return {
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
