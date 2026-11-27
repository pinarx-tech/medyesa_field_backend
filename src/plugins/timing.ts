import { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    _startHrTime?: bigint;
  }
}

export async function registerTimingPlugin(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', async (req) => {
    req._startHrTime = process.hrtime.bigint();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req._startHrTime !== undefined) {
      const elapsedMs = Number(process.hrtime.bigint() - req._startHrTime) / 1e6;
      const rounded = elapsedMs.toFixed(1);
      reply.header('X-Response-Time-Ms', rounded);
      reply.header('Server-Timing', `app;dur=${rounded}`);
    }
    return payload;
  });
}
