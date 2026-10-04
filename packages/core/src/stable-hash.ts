import { createHash, createHmac } from 'node:crypto';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/**
 * Key-order-independent SHA-256, so equal states hash equally. Pass a secret to get an HMAC instead:
 * a plain hash of a low-entropy value (an email, a phone number) can be reversed by guessing.
 * Hash normalized state (see normalizeState) so Dates and other JSON-converted values compare by
 * what the provider actually receives.
 */
export function stableHash(value: unknown, secret?: string): string {
  const text = JSON.stringify(stable(value)) ?? 'undefined';
  return (secret ? createHmac('sha256', secret) : createHash('sha256')).update(text).digest('hex');
}
