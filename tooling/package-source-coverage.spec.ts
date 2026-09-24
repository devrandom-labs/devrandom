import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import vitestConfig from '../vitest.config.ts';
import { loadWorkspace } from './workspace-boundaries.js';

const packageDirectories = [
  'packages/domain',
  'packages/identity',
  'packages/protocol',
  'packages/runtime',
  'packages/storage',
] as const;

interface ObjectValue {
  readonly [key: string]: unknown;
}

function isObjectValue(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, path: string): ObjectValue {
  if (!isObjectValue(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }

  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${path} must contain an array of strings`);
  }

  return value;
}

describe('package source coverage', () => {
  it('keeps every production package inside every repository gate', async () => {
    const root = process.cwd();
    const rootConfig: unknown = JSON.parse(await readFile(resolve(root, 'tsconfig.json'), 'utf8'));
    const rootConfigObject = objectValue(rootConfig, 'tsconfig.json');
    const vitestConfigObject = objectValue(vitestConfig, 'vitest.config.ts');
    const vitestTestConfig = objectValue(vitestConfigObject.test, 'vitest.config.ts test');

    expect(stringArray(rootConfigObject.include, 'tsconfig.json include')).toContain(
      'packages/**/*.ts',
    );
    expect(stringArray(vitestTestConfig.include, 'vitest.config.ts test.include')).toContain(
      'packages/**/*.spec.ts',
    );

    const workspace = await loadWorkspace(root);
    const coveredDirectories = new Set(workspace.map(({ directory }) => directory));
    const eslint = new ESLint({ cwd: root });

    for (const directory of packageDirectories) {
      const manifestPath = resolve(root, directory, 'package.json');
      const manifest = objectValue(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath);
      const scripts = objectValue(manifest.scripts, `${manifestPath} scripts`);

      expect(coveredDirectories.has(directory), `${directory} boundary coverage`).toBe(true);
      expect(typeof scripts.build, `${directory} build script`).toBe('string');
      await expect(access(resolve(root, directory, 'src/index.ts'))).resolves.toBeUndefined();
      await expect(
        access(resolve(root, directory, 'tsconfig.build.json')),
      ).resolves.toBeUndefined();
      await expect(eslint.isPathIgnored(`${directory}/src/index.ts`)).resolves.toBe(false);
    }
  });
});
