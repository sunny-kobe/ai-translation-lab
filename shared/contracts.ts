import { Type, FormatRegistry, type Static } from '@sinclair/typebox';
import { languageOptions } from './languages';
FormatRegistry.Set('uuid', (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
);
export const Language = Type.Union(
  languageOptions.map((l) => Type.Literal(l.value)),
);
const Text = Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' });
export const Term = Type.Object(
  {
    source: Text,
    targets: Type.Record(Language, Type.Optional(Text)),
  },
  { additionalProperties: false },
);
export const Scenario = Type.Union([
  Type.Literal('normal'),
  Type.Literal('transient'),
  Type.Literal('malformed'),
  Type.Literal('partial'),
]);
export const CreateJob = Type.Object(
  {
    entries: Type.Array(
      Type.Object(
        {
          key: Type.String({
            minLength: 1,
            maxLength: 120,
            pattern: '^[a-zA-Z0-9_.-]+$',
          }),
          text: Text,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 50 },
    ),
    languages: Type.Array(Language, {
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
    }),
    glossary: Type.Optional(Type.Array(Term, { maxItems: 30 })),
    scenario: Type.Optional(Scenario),
  },
  { additionalProperties: false },
);
export const EditResult = Type.Object(
  {
    text: Text,
    approved: Type.Boolean(),
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const ProviderInput = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    text: Text,
    language: Language,
    glossary: Type.Array(Term),
    attempt: Type.Integer({ minimum: 1 }),
    scenario: Scenario,
  },
  { additionalProperties: false },
);
export const ProviderOutput = Type.Object(
  { key: Type.String(), language: Language, text: Text },
  { additionalProperties: false },
);
export const KeyProviderInput = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    text: Text,
    languages: Type.Array(Language, {
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
    }),
    glossary: Type.Array(Term),
    attempts: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
    scenario: Scenario,
  },
  { additionalProperties: false },
);
export type KeyTranslateInput = Static<typeof KeyProviderInput>;
export interface ProviderSnapshot {
  name: 'fake' | 'zhipu';
  model: string | null;
  promptVersion: string;
}
export const promptVersion = 'key-multilingual-v2';
export interface CallUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
}
export interface KeyProviderReply {
  output: unknown;
  usage: CallUsage | null;
}
export type JobInput = Static<typeof CreateJob>;
export type TranslateInput = Static<typeof ProviderInput>;
export type Glossary = Static<typeof Term>[];
export type ItemStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobStatus = ItemStatus | 'partial';
export interface ResultRow {
  id: string;
  job_id: string;
  source_key: string;
  source_text: string;
  language: string;
  status: ItemStatus;
  target_text: string | null;
  attempts: number;
  error_code: string | null;
  human_edited: boolean;
  approved: boolean;
  revision: number;
}
export interface JobRow {
  id: string;
  status: JobStatus;
  languages: string[];
  glossary: Glossary;
  fake_scenario: TranslateInput['scenario'];
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  failed: number;
  approved: number;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
}
export const ResultResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  job_id: Type.String({ format: 'uuid' }),
  source_key: Type.String(),
  source_text: Type.String(),
  language: Language,
  status: Type.Union(
    ['queued', 'running', 'succeeded', 'failed'].map((v) => Type.Literal(v)),
  ),
  target_text: Type.Union([Type.String(), Type.Null()]),
  attempts: Type.Integer(),
  error_code: Type.Union([Type.String(), Type.Null()]),
  human_edited: Type.Boolean(),
  approved: Type.Boolean(),
  revision: Type.Integer(),
});
export const JobResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: Type.Union(
    ['queued', 'running', 'succeeded', 'partial', 'failed'].map((v) =>
      Type.Literal(v),
    ),
  ),
  languages: Type.Array(Language),
  glossary: Type.Array(Term),
  fake_scenario: Scenario,
  provider: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  prompt_version: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  updated_at: Type.String(),
  total: Type.Integer(),
  completed: Type.Integer(),
  failed: Type.Integer(),
  approved: Type.Integer(),
});
