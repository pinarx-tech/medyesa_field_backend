import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';
import { getEnv } from '../env.js';

export async function registerCors(app: FastifyInstance): Promise<void> {
  const allowed = getEnv()
    .CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow non-browser clients (Flutter mobile app, curl) without Origin header.
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
}
