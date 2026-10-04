/**
 * The few Redis commands the adapters use, in the shape `ioredis` exposes them. Any `ioredis`
 * client (or a cluster client) satisfies it, so this package has no runtime dependency on Redis
 * libraries and you keep control of connection options, TLS and retries.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
}
