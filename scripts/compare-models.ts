import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { ZhipuTranslator } from '../server/providers';
import { QualityError, validateTranslation } from '../server/quality';
import type { TranslateInput } from '../shared/contracts';
if (process.env.MODEL_COMPARE_ENABLED !== '1')
  throw new Error(
    'Set MODEL_COMPARE_ENABLED=1 to authorize 8 real model comparison calls',
  );
const samples = JSON.parse(
  await readFile('tests/fixtures/quality.json', 'utf8'),
);
samples.push({
  key: 'repeat',
  text: 'Hello {name}, {name}! Save %1$s for {{recipient}}.',
  language: 'ja',
  glossary: [],
});
const realFetch = globalThis.fetch;
let responseSummary: Record<string, unknown> = {};
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  responseSummary = {
    httpStatus: response.status,
    responseModel: body?.model ?? null,
    usage: body?.usage ?? null,
    finishReason: body?.choices?.[0]?.finish_reason ?? null,
  };
  return response;
};
const rows: Record<string, unknown>[] = [];
await mkdir('output', { recursive: true });
try {
  for (const model of ['glm-5.3-flash', 'glm-4.7-flash']) {
    process.env.ZHIPU_MODEL = model;
    const provider = new ZhipuTranslator();
    for (const sample of samples) {
      const input: TranslateInput = {
        key: sample.key,
        text: sample.text,
        language: sample.language,
        glossary: sample.glossary,
        attempt: 1,
        scenario: 'normal',
      };
      const started = performance.now();
      responseSummary = {};
      let text: null | string = null,
        errorCode: null | string = null;
      try {
        text = validateTranslation(
          input,
          await provider.translate(
            input,
            AbortSignal.timeout(provider.timeoutMs),
          ),
        );
      } catch (error) {
        errorCode =
          error instanceof QualityError ? error.code : 'PROVIDER_ERROR';
      }
      const usage = responseSummary.usage as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          }
        | undefined;
      const cost =
        model === 'glm-4.7-flash'
          ? 0
          : usage?.prompt_tokens !== undefined &&
              usage?.completion_tokens !== undefined
            ? (usage.prompt_tokens * 0.8 + usage.completion_tokens * 2.8) / 1e6
            : null;
      const row = {
        requestedModel: model,
        key: input.key,
        language: input.language,
        source: input.text,
        text,
        passedMechanicalChecks: errorCode === null,
        errorCode,
        durationMs: Math.round(performance.now() - started),
        ...responseSummary,
        standardCostUpperEstimateYuan: cost,
      };
      rows.push(row);
      await writeFile(
        'output/model-comparison.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            priceBasis:
              '2026-10-01 official standard API pricing; all input assumed uncached; bill unverified; recheck pricing before reuse',
            semanticReview: 'not blinded; no accuracy rate claimed',
            rows,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(row));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
} finally {
  globalThis.fetch = realFetch;
}
