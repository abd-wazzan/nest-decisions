import { describe, expect, it } from 'vitest';
import { stableHash } from '../src';

describe('stableHash', () => {
  it('ignores key order, respects values and arrays', () => {
    expect(stableHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      stableHash({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
    expect(stableHash(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});
