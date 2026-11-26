import { randomInt } from 'node:crypto';

/**
 * Generates a readable, cryptographically secure temporary password in the
 * exact format `[FirstName]@[six random digits]` (e.g. `Sujan@482731`).
 *
 * Security rules:
 * - Uses Node's CSPRNG (`crypto.randomInt`) for uniform 6-digit selection.
 * - Never log or persist the returned plaintext string.
 * - Hash immediately with Argon2id (`hashPassword`) and set `mustChangePassword = true`.
 */
export function generateTemporaryPassword(displayName: string): string {
  const firstToken = displayName.trim().split(/\s+/)[0] ?? '';
  const lettersOnly = firstToken.replace(/[^A-Za-z]/g, '');
  const prefix =
    lettersOnly.length > 0
      ? lettersOnly.charAt(0).toUpperCase() + lettersOnly.slice(1).toLowerCase()
      : 'User';

  const sixDigits = randomInt(0, 1_000_000).toString().padStart(6, '0');
  return `${prefix}@${sixDigits}`;
}
