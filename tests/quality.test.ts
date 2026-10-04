import { describe, it, expect } from 'vitest';
import { validateTranslation, aggregateStatus } from '../server/quality';
import type { TranslateInput } from '../shared/contracts';
const input: TranslateInput = {
  key: 'welcome',
  text: 'Hello {name}, Nova!',
  language: 'zh',
  glossary: [{ source: 'Nova', targets: { zh: 'Nova' } }],
  attempt: 1,
  scenario: 'normal' as const,
};
import fixtures from './fixtures/quality.json';
describe('quality contract', () => {
  it.each(fixtures)('checks mechanical quality sample $key', (sample) => {
    expect(
      validateTranslation(
        {
          key: sample.key,
          text: sample.text,
          glossary: sample.glossary,
          language: sample.language as TranslateInput['language'],
          attempt: 1,
          scenario: 'normal',
        },
        { key: sample.key, language: sample.language, text: sample.candidate },
      ),
    ).toBe(sample.candidate);
  });
  it('accepts matching keys, languages, terms and placeholders', () => {
    expect(
      validateTranslation(input, {
        key: 'welcome',
        language: 'zh',
        text: '你好 {name}，Nova！',
      }),
    ).toBe('你好 {name}，Nova！');
  });
  it.each([
    [
      { key: 'other', language: 'zh', text: '你好 {name}, Nova' },
      'KEY_MISMATCH',
    ],
    [
      { key: 'welcome', language: 'fr', text: '你好 {name}, Nova' },
      'LANGUAGE_MISMATCH',
    ],
    [{ key: 'welcome', language: 'zh', text: 123 }, 'OUTPUT_SCHEMA'],
    [
      { key: 'welcome', language: 'zh', text: '你好，Nova' },
      'PLACEHOLDER_MISMATCH',
    ],
    [{ key: 'welcome', language: 'zh', text: '你好 {name}' }, 'TERM_MISMATCH'],
  ])('rejects invalid output %j', (output, code) =>
    expect(() => validateTranslation(input, output)).toThrow(code),
  );
  it('requires repeated and positional placeholders to match exactly', () => {
    expect(() =>
      validateTranslation(
        { ...input, text: '%1$s {{name}} %d %d' },
        { key: 'welcome', language: 'zh', text: '%1$s {{name}} %d Nova' },
      ),
    ).toThrow('PLACEHOLDER_MISMATCH');
  });
  it('distinguishes partial success from total failure and in-flight work', () => {
    expect(aggregateStatus(['succeeded', 'failed'])).toBe('partial');
    expect(aggregateStatus(['failed'])).toBe('failed');
    expect(aggregateStatus(['succeeded', 'succeeded'])).toBe('succeeded');
    expect(aggregateStatus(['succeeded', 'queued'])).toBe('running');
    expect(aggregateStatus(['queued', 'queued'])).toBe('queued');
  });
});
