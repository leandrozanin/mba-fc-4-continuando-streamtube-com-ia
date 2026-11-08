import { randomBytes } from 'crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SLUG_LENGTH = 11;
// Largest multiple of 62 below 256: bytes at or above it are rejected so every
// character is equally likely (no modulo bias)
const REJECTION_LIMIT = 256 - (256 % ALPHABET.length);

export function generateSlug(): string {
  let slug = '';
  while (slug.length < SLUG_LENGTH) {
    for (const byte of randomBytes(SLUG_LENGTH * 2)) {
      if (byte >= REJECTION_LIMIT) continue;
      slug += ALPHABET[byte % ALPHABET.length];
      if (slug.length === SLUG_LENGTH) break;
    }
  }
  return slug;
}
