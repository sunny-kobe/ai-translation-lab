import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZhipuTranslator } from '../server/providers';

const input = {
  key: 'welcome',
  text: 'Hello {name}, Nova!',
  language: 'zh' as const,
  glossary: [{ source: 'Nova', targets: { zh: 'Nova' } }],
  attempt: 1,
  scenario: 'normal' as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ZhipuTranslator', () => {
  it('sends a structured translation request and parses JSON content', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_MODEL', 'glm-4.7');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"key":"welcome","language":"zh","text":"你好 {name}，Nova！"}\n```',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const output = await new ZhipuTranslator().translate(
      input,
      new AbortController().signal,
    );

    expect(output).toEqual({
      key: 'welcome',
      language: 'zh',
      text: '你好 {name}，Nova！',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('glm-4.7');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages[1].content).toContain('welcome');
  });

  it.each(['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'])(
    'uses mandatory light reasoning for %s',
    async (model) => {
      vi.stubEnv('ZHIPU_API_KEY', 'test-key');
      vi.stubEnv('ZHIPU_MODEL', model);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    key: input.key,
                    language: input.language,
                    text: '你好 {name}，Nova！',
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      await new ZhipuTranslator().translate(
        input,
        new AbortController().signal,
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('low');
      expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
    },
  );

  it('omits unrelated glossary terms from paid requests', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  key: input.key,
                  language: input.language,
                  text: '你好 {name}，Nova！',
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await new ZhipuTranslator().translate(
      {
        ...input,
        glossary: [
          ...input.glossary,
          { source: 'Unrelated', targets: { zh: '无关' } },
        ],
      },
      new AbortController().signal,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.messages[1].content).glossary).toEqual([
      { source: 'Nova', target: 'Nova' },
    ]);
  });

  it('rejects a truncated completion even when its JSON looks valid', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    key: input.key,
                    language: input.language,
                    text: '你好 {name}，Nova！',
                  }),
                },
                finish_reason: 'length',
              },
            ],
          }),
        ),
      ),
    );
    await expect(
      new ZhipuTranslator().translate(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED', retryable: false });
  });

  it('normalizes provider HTTP failures for worker retries', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('busy', { status: 429 })),
    );

    await expect(
      new ZhipuTranslator().translate(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });

  it('fails at startup when credentials are missing', () => {
    vi.stubEnv('ZHIPU_API_KEY', '');
    expect(() => new ZhipuTranslator()).toThrow('ZHIPU_API_KEY');
  });

  it('validates input before making a paid request', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new ZhipuTranslator().translate(
        { ...input, text: '' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INPUT_SCHEMA' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps cancelled requests to timeout errors without leaking raw errors', async () => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    const abort = new AbortController();
    abort.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('secret')),
    );
    await expect(
      new ZhipuTranslator().translate(input, abort.signal),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it.each([401, 402, 403, 400])(
    'does not retry permanent HTTP %i errors',
    async (status) => {
      vi.stubEnv('ZHIPU_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('secret', { status })),
      );
      await expect(
        new ZhipuTranslator().translate(input, new AbortController().signal),
      ).rejects.toMatchObject({ retryable: false });
    },
  );

  it.each([
    null,
    {},
    { choices: [] },
    {
      choices: [
        {
          message: {
            content:
              'Some text {"key":"welcome","language":"zh","text":"你好"}',
          },
        },
      ],
    },
  ])('rejects malformed or unstructured responses', async (body) => {
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    );
    await expect(
      new ZhipuTranslator().translate(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'OUTPUT_SCHEMA' });
  });
});
