import Fastify, { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { getPrisma } from './lib/prisma.js';
import { registerCors } from './plugins/cors.js';
import { registerRateLimit } from './plugins/rateLimit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHcRoutes } from './routes/hc.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMrRoutes } from './routes/mr.js';

export interface BuildAppOptions {
  prisma?: PrismaClient;
  disableRateLimit?: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const prisma = options.prisma ?? getPrisma();
  const app: FastifyInstance = Fastify({
    logger: createLogger() as any,
    genReqId: () => `req-${randomUUID()}`,
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await registerCors(app);
  if (!options.disableRateLimit) {
    await registerRateLimit(app);
  }

  app.setNotFoundHandler((req, reply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Route not found.',
        requestId: req.id,
      },
    });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
          ...(err.details ? { details: err.details } : {}),
          requestId: req.id,
        },
      });
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed.',
          fieldErrors: err.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
          requestId: req.id,
        },
      });
    }

    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'FST_ERR_VALIDATION'
    ) {
      const validation = (
        err as {
          validation?: Array<{ instancePath?: string; message?: string }>;
        }
      ).validation;
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed.',
          fieldErrors: (validation ?? []).map((v) => ({
            field: (v.instancePath ?? '').replace(/^\//, ''),
            message: v.message ?? 'Invalid value',
          })),
          requestId: req.id,
        },
      });
    }

    if (
      typeof err === 'object' &&
      err !== null &&
      ('statusCode' in err && (err as { statusCode?: number }).statusCode === 429) || ('error' in err && (err as any).error?.code === 'rate_limited') || reply.statusCode === 429
    ) {
      return reply.status(429).send({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Please slow down.',
          requestId: req.id,
        },
      });
    }

    req.log.error({ err }, 'Unhandled internal error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
        requestId: req.id,
      },
    });
  });

  await registerHealthRoutes(app, prisma);
  await registerAuthRoutes(app, prisma);
  await registerAdminRoutes(app, prisma);
  await registerHcRoutes(app, prisma);
  await registerMrRoutes(app, prisma);

  return app;
}
