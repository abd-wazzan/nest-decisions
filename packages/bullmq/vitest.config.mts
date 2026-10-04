import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    coverage: { provider: 'v8', include: ['src/**'], thresholds: { lines: 90 } },
  },
});
