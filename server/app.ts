import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Type, type Static } from '@sinclair/typebox';
import type pg from 'pg';
import {
  CreateJob,
  EditResult,
  JobResponse,
  ResultResponse,
} from '../shared/contracts';
import { ApiError, Store } from './store';
import { QualityError } from './quality';
import type { ProviderSnapshot } from '../shared/contracts';
const JobParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const ItemParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  itemId: Type.String({ format: 'uuid' }),
});
const ExportParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  lang: Type.String(),
});
export async function buildApp(
  pool: pg.Pool,
  logging = true,
  providerInfo: ProviderSnapshot = {
    name: 'fake',
    model: null,
    promptVersion: 'unknown',
  },
) {
  const app = Fastify({
    logger: logging
      ? {
          level: 'info',
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        }
      : false,
    bodyLimit: 300000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const store = new Store(pool, providerInfo);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AI Translation Lab',
        version: '0.1.0',
        description:
          'Local translation learning project. Model results require human review.',
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof QualityError)
      return reply.code(422).send({ message: error.code });
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ message: error.message });
    if (error instanceof Error && 'validation' in error)
      return reply
        .code(400)
        .send({ message: 'Invalid request', details: error.message });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ message: 'Invalid request' });
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ message: 'Internal server error' });
  });
  app.get(
    '/api/health',
    {
      schema: {
        response: {
          200: Type.Object({
            status: Type.Literal('ok'),
            provider: Type.Union([Type.Literal('fake'), Type.Literal('zhipu')]),
            model: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async () => {
      await pool.query('SELECT 1');
      return {
        status: 'ok',
        provider: providerInfo.name,
        model: providerInfo.model,
      };
    },
  );
  app.post<{ Body: Static<typeof CreateJob> }>(
    '/api/jobs',
    { schema: { body: CreateJob, response: { 202: JobResponse } } },
    async (req, reply) => {
      const job = await store.create(req.body);
      return reply.code(202).send(job);
    },
  );
  app.get(
    '/api/jobs',
    { schema: { response: { 200: Type.Array(JobResponse) } } },
    () => store.list(),
  );
  app.get<{ Params: Static<typeof JobParams> }>(
    '/api/jobs/:id',
    { schema: { params: JobParams, response: { 200: JobResponse } } },
    (req) => store.job(req.params.id),
  );
  app.get<{ Params: Static<typeof JobParams> }>(
    '/api/jobs/:id/items',
    {
      schema: {
        params: JobParams,
        response: { 200: Type.Array(ResultResponse) },
      },
    },
    (req) => store.items(req.params.id),
  );
  app.patch<{
    Params: Static<typeof ItemParams>;
    Body: Static<typeof EditResult>;
  }>(
    '/api/jobs/:id/items/:itemId',
    {
      schema: {
        params: ItemParams,
        body: EditResult,
        response: { 200: ResultResponse },
      },
    },
    (req) => store.edit(req.params.id, req.params.itemId, req.body),
  );
  app.post<{ Params: Static<typeof JobParams> }>(
    '/api/jobs/:id/retry',
    { schema: { params: JobParams, response: { 200: JobResponse } } },
    (req) => store.retry(req.params.id),
  );
  app.get<{ Params: Static<typeof ExportParams> }>(
    '/api/jobs/:id/export/:lang',
    {
      schema: {
        params: ExportParams,
        response: { 200: Type.Record(Type.String(), Type.String()) },
      },
    },
    async (req, reply) => {
      const data = await store.export(req.params.id, req.params.lang);
      return reply
        .header(
          'Content-Disposition',
          `attachment; filename="${req.params.lang}.json"`,
        )
        .send(data);
    },
  );
  return app;
}
