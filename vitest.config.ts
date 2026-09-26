import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  test: {
    maxWorkers: 4,
    coverage: {
      enabled: false,
    },
    include: [
      'apps/**/*.spec.ts',
      'apps/**/*.spec.tsx',
      'packages/**/*.spec.ts',
      'services/**/*.spec.ts',
      'tooling/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', 'apps/site/e2e/**', 'apps/demo/e2e/**'],
  },
});
