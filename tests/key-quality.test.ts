import { describe, it, expect } from 'vitest';
import { validateKeyTranslation } from '../server/quality';
import { languageOptions } from '../shared/languages';
const input = {
  key: 'hello',
  text: 'Hello {name}!',
  languages: ['zh', 'fr'],
  glossary: [],
  attempts: { zh: 1, fr: 1 },
  scenario: 'normal' as const,
};
describe('one key, many languages', () => {
  it('has 50 unique supported languages', () => {
    expect(languageOptions).toHaveLength(50);
    expect(new Set(languageOptions.map((l) => l.value)).size).toBe(50);
  });
  it('matches by language, independent of response order', () => {
    const results = validateKeyTranslation(input, {
      key: 'hello',
      translations: [
        { language: 'fr', text: 'Bonjour {name}!' },
        { language: 'zh', text: '你好 {name}！' },
      ],
    });
    expect(results.get('zh')).toEqual({ text: '你好 {name}！', error: null });
  });
  it('keeps successes while only missing/invalid languages fail', () => {
    const results = validateKeyTranslation(
      {
        ...input,
        languages: ['zh', 'fr', 'ja'],
        attempts: { zh: 1, fr: 1, ja: 1 },
      },
      {
        key: 'hello',
        translations: [
          { language: 'zh', text: '你好 {name}' },
          { language: 'fr', text: 'Bonjour' },
        ],
      },
    );
    expect(results.get('zh')?.error).toBeNull();
    expect(results.get('fr')?.error?.code).toBe('PLACEHOLDER_MISMATCH');
    expect(results.get('ja')?.error?.code).toBe('LANGUAGE_MISSING');
  });
  it.each([
    { key: 'other', translations: [] },
    {
      key: 'hello',
      translations: [
        { language: 'zh', text: '你好 {name}' },
        { language: 'zh', text: '重复 {name}' },
      ],
    },
    { key: 'hello', translations: [{ language: 'es', text: 'Hola {name}' }] },
  ])('rejects ambiguous or unrelated batch outputs', (output) => {
    expect(() => validateKeyTranslation(input, output)).toThrow();
  });
});
