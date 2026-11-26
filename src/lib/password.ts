import { Algorithm, hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';

/** OWASP 2024 Argon2id parameters: 19 MiB memory, 2 iterations, 1 thread, 32-byte hash. */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
