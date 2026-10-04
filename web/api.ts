import { Value } from '@sinclair/typebox/value';
import { Type, type TSchema } from '@sinclair/typebox';
import {
  JobResponse,
  ResultResponse,
  type JobRow,
  type JobInput,
  type ResultRow,
} from '../shared/contracts';
async function request<T>(
  path: string,
  schema: TSchema,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      data && typeof data === 'object' && 'message' in data
        ? String(data.message)
        : '请求失败',
    );
  if (!Value.Check(schema, data)) throw new Error('服务返回结构不符合契约');
  return data as T;
}
export const api = {
  health: () =>
    request<{ status: 'ok'; provider: 'fake' | 'zhipu'; model: string | null }>(
      '/health',
      Type.Object({
        status: Type.Literal('ok'),
        provider: Type.Union([Type.Literal('fake'), Type.Literal('zhipu')]),
        model: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
  jobs: () => request<JobRow[]>('/jobs', Type.Array(JobResponse)),
  job: (id: string) => request<JobRow>(`/jobs/${id}`, JobResponse),
  items: (id: string) =>
    request<ResultRow[]>(`/jobs/${id}/items`, Type.Array(ResultResponse)),
  create: (input: JobInput) =>
    request<JobRow>('/jobs', JobResponse, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  edit: (
    id: string,
    itemId: string,
    input: { text: string; approved: boolean; revision: number },
  ) =>
    request<ResultRow>(`/jobs/${id}/items/${itemId}`, ResultResponse, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  retry: (id: string) =>
    request<JobRow>(`/jobs/${id}/retry`, JobResponse, { method: 'POST' }),
  export: async (id: string, language: string) => {
    const data = await request<Record<string, string>>(
      `/jobs/${id}/export/${language}`,
      Type.Record(Type.String(), Type.String()),
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2) + '\n'], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${language}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
