import { Value } from '@sinclair/typebox/value';
import {
  ProviderInput,
  ProviderOutput,
  type TranslateInput,
  type ItemStatus,
  type JobStatus,
  type KeyTranslateInput,
  type CallUsage,
} from '../shared/contracts';
export class QualityError extends Error {
  constructor(
    public code: string,
    public retryable = true,
    public retryAfterMs = 0,
    public usage: CallUsage | null = null,
  ) {
    super(code);
  }
}
export function validateKeyTranslation(
  input: KeyTranslateInput,
  output: unknown,
) {
  if (!output || typeof output !== 'object' || Array.isArray(output))
    throw new QualityError('OUTPUT_SCHEMA');
  const record = output as { key?: unknown; translations?: unknown };
  if (
    Object.keys(record).some((k) => !['key', 'translations'].includes(k)) ||
    !Array.isArray(record.translations)
  )
    throw new QualityError('OUTPUT_SCHEMA');
  if (record.key !== input.key) throw new QualityError('KEY_MISMATCH');
  const values = new Map<string, unknown>();
  for (const row of record.translations) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      typeof row.language !== 'string' ||
      Object.keys(row).some((k) => !['language', 'text'].includes(k))
    )
      throw new QualityError('OUTPUT_SCHEMA');
    if (!input.languages.includes(row.language))
      throw new QualityError('LANGUAGE_MISMATCH');
    if (values.has(row.language)) throw new QualityError('LANGUAGE_DUPLICATE');
    values.set(row.language, row.text);
  }
  const results = new Map<
    string,
    { text: string | null; error: QualityError | null }
  >();
  for (const language of input.languages) {
    try {
      if (!values.has(language)) throw new QualityError('LANGUAGE_MISSING');
      const text = validateTranslation(
        {
          key: input.key,
          text: input.text,
          language,
          glossary: input.glossary,
          attempt: input.attempts[language],
          scenario: input.scenario,
        },
        { key: input.key, language, text: values.get(language) },
      );
      results.set(language, { text, error: null });
    } catch (error) {
      results.set(language, {
        text: null,
        error:
          error instanceof QualityError
            ? error
            : new QualityError('OUTPUT_SCHEMA'),
      });
    }
  }
  return results;
}
export const placeholders = (text: string) =>
  (
    text.match(
      /\{\{[a-zA-Z_][\w.]*\}\}|\{[a-zA-Z_][\w.]*\}|%(?:[1-9]\d*\$)?[sdif]/g,
    ) || []
  ).sort();
export function validateTranslation(
  input: TranslateInput,
  output: unknown,
): string {
  if (!Value.Check(ProviderInput, input))
    throw new QualityError('INPUT_SCHEMA');
  if (!Value.Check(ProviderOutput, output))
    throw new QualityError('OUTPUT_SCHEMA');
  if (output.key !== input.key) throw new QualityError('KEY_MISMATCH');
  if (output.language !== input.language)
    throw new QualityError('LANGUAGE_MISMATCH');
  if (
    JSON.stringify(placeholders(input.text)) !==
    JSON.stringify(placeholders(output.text))
  )
    throw new QualityError('PLACEHOLDER_MISMATCH');
  for (const term of input.glossary) {
    if (
      input.text.includes(term.source) &&
      !output.text.includes(
        (term.targets as Record<string, string | undefined>)[input.language] ||
          term.source,
      )
    )
      throw new QualityError('TERM_MISMATCH');
  }
  return output.text;
}
export function aggregateStatus(states: ItemStatus[]): JobStatus {
  if (states.every((s) => s === 'queued')) return 'queued';
  if (states.some((s) => s === 'queued' || s === 'running')) return 'running';
  if (states.every((s) => s === 'succeeded')) return 'succeeded';
  if (states.every((s) => s === 'failed')) return 'failed';
  return 'partial';
}
