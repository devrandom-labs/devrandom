import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  test: {
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
    exclude: ['**/node_modules/**', 'apps/site/e2e/**'],
  },
});
