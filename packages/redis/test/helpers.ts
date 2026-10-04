import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL;

/**
 * Integration tests run against a real Redis only when REDIS_URL is set (use a throwaway database,
 * for example redis://localhost:6379/15). Every test uses a unique prefix and removes only its own
 * keys, so it never touches anything else in that database.
 */
export function connect(): Redis {
  if (!REDIS_URL) throw new Error('REDIS_URL is not set');
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
}

export const uniquePrefix = (): string => `{nd-test-${randomUUID()}}`;

export async function deleteByPrefix(client: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length) await client.del(...keys);
  } while (cursor !== '0');
}
