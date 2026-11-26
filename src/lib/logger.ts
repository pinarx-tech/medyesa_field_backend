import pino from 'pino';
import { getEnv } from '../env.js';

export function createLogger() {
  const env = getEnv();
  return pino({
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        '*.password',
        '*.passwordHash',
        '*.temporaryPassword',
        '*.initialPassword',
        '*.newPassword',
        '*.currentPassword',
        '*.refreshToken',
        '*.accessToken',
      ],
      censor: '[REDACTED]',
    },
  });
}
