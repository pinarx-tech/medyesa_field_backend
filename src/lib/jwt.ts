import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import { getEnv } from '../env.js';
import { AppError } from './errors.js';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  jti: string;
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWT_SECRET);
}

/**
 * Issues a 15-minute HS256 JWT.
 * Intentionally omits `companyId` — always loaded from DB per request.
 */
export async function signAccessToken(input: {
  userId: string;
  role: Role;
}): Promise<string> {
  return new SignJWT({ role: input.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getSecretKey());
}

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ['HS256'],
    });
    const sub = payload.sub;
    const role = payload.role;
    const jti = payload.jti;
    if (
      typeof sub !== 'string' ||
      typeof jti !== 'string' ||
      (role !== Role.platformAdmin &&
        role !== Role.headController &&
        role !== Role.mr)
    ) {
      throw new AppError('unauthenticated', 401, 'Invalid access token.');
    }
    return { sub, role, jti };
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(
      'unauthenticated',
      401,
      'Invalid or expired access token.',
    );
  }
}
