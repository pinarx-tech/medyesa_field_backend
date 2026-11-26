import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrismaClient, Role } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { buildAuthPreHandler, requireRoles } from '../plugins/auth.js';
import { DoctorRepo } from '../repos/doctorRepo.js';
import { VisitRepo } from '../repos/visitRepo.js';
import {
  createVisitBodySchema,
  endWorkdayBodySchema,
  startWorkdayBodySchema,
  syncBatchBodySchema,
  upsertVisitNoteBodySchema,
  visitIdParamSchema,
} from '../schemas/mr.js';

export async function registerMrRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = buildAuthPreHandler(prisma);
  const onlyMr = [authenticate, requireRoles([Role.mr])];

  typed.get('/v1/mr/today', { preHandler: onlyMr }, async (req) => {
    const repo = new VisitRepo(prisma, req.authUser!);
    return repo.getTodayForMr();
  });

  typed.post(
    '/v1/mr/workday/start',
    { preHandler: onlyMr, schema: { body: startWorkdayBodySchema } },
    async (req, reply) => {
      const repo = new VisitRepo(prisma, req.authUser!);
      const result = await repo.startWorkDay(req.body);
      return reply.status(result.deduplicated ? 200 : 201).send(result);
    },
  );

  typed.post(
    '/v1/mr/workday/end',
    { preHandler: onlyMr, schema: { body: endWorkdayBodySchema } },
    async (req) => {
      const repo = new VisitRepo(prisma, req.authUser!);
      return repo.endWorkDay(req.body);
    },
  );

  typed.get('/v1/mr/doctors', { preHandler: onlyMr }, async (req) => {
    const repo = new DoctorRepo(prisma, req.authUser!);
    return { doctors: await repo.listForMrSelf() };
  });

  typed.post(
    '/v1/mr/visits',
    { preHandler: onlyMr, schema: { body: createVisitBodySchema } },
    async (req, reply) => {
      const repo = new VisitRepo(prisma, req.authUser!);
      const result = await repo.createVisit(req.body);
      return reply.status(result.deduplicated ? 200 : 201).send(result);
    },
  );

  typed.patch(
    '/v1/mr/visits/:id/note',
    {
      preHandler: onlyMr,
      schema: { params: visitIdParamSchema, body: upsertVisitNoteBodySchema },
    },
    async (req) => {
      const repo = new VisitRepo(prisma, req.authUser!);
      return repo.upsertVisitNote(req.params.id, req.body.noteText);
    },
  );

  typed.post(
    '/v1/mr/sync/batch',
    { preHandler: onlyMr, schema: { body: syncBatchBodySchema } },
    async (req) => {
      const repo = new VisitRepo(prisma, req.authUser!);
      const results: Array<{
        clientId: string;
        status: 'synced' | 'failed';
        serverId?: string;
        deduplicated?: boolean;
        error?: { code: string; message: string };
      }> = [];

      for (const op of req.body.operations) {
        try {
          if (op.entityType === 'workDay' && op.operation === 'start') {
            const parsed = startWorkdayBodySchema.parse({
              ...op.payload,
              clientId: op.clientId,
            });
            const res = await repo.startWorkDay(parsed);
            results.push({
              clientId: op.clientId,
              status: 'synced',
              serverId: res.serverId,
              deduplicated: res.deduplicated,
            });
          } else if (op.entityType === 'workDay' && op.operation === 'end') {
            const parsed = endWorkdayBodySchema.parse({
              ...op.payload,
              clientId: op.clientId,
            });
            const res = await repo.endWorkDay(parsed);
            results.push({
              clientId: op.clientId,
              status: 'synced',
              serverId: res.serverId,
              deduplicated: res.deduplicated,
            });
          } else if (op.entityType === 'visit' && op.operation === 'create') {
            const parsed = createVisitBodySchema.parse({
              ...op.payload,
              clientId: op.clientId,
              capturedAtClient:
                (op.payload.capturedAtClient as string | undefined) ??
                op.capturedAtClient,
            });
            const res = await repo.createVisit(parsed);
            results.push({
              clientId: op.clientId,
              status: 'synced',
              serverId: res.serverId,
              deduplicated: res.deduplicated,
            });
          } else if (
            op.entityType === 'visitNote' &&
            op.operation === 'upsert'
          ) {
            const parsed = upsertVisitNoteBodySchema.parse(op.payload);
            const res = await repo.upsertVisitNote(
              op.entityId,
              parsed.noteText,
            );
            results.push({
              clientId: op.clientId,
              status: 'synced',
              serverId: res.note?.id ?? res.visitId,
            });
          } else {
            throw new AppError(
              'validation_error',
              400,
              `Unsupported sync operation: ${op.entityType}.${op.operation}`,
            );
          }
        } catch (err) {
          if (err instanceof AppError) {
            results.push({
              clientId: op.clientId,
              status: 'failed',
              error: { code: err.code, message: err.message },
            });
          } else {
            results.push({
              clientId: op.clientId,
              status: 'failed',
              error: {
                code: 'validation_error',
                message:
                  err instanceof Error ? err.message : 'Operation failed',
              },
            });
          }
        }
      }

      return { results };
    },
  );

  typed.get('/v1/mr/sync/status', { preHandler: onlyMr }, async (req) => {
    const repo = new VisitRepo(prisma, req.authUser!);
    return repo.getSyncStatusForMr();
  });
}
