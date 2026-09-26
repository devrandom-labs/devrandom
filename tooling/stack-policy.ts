import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export type StackPolicyViolation =
  | {
      readonly kind: 'missing-dependency';
      readonly manifest: string;
      readonly packageName: string;
    }
  | {
      readonly kind: 'forbidden-dependency';
      readonly manifest: string;
      readonly packageName: string;
    };

interface ManifestPolicy {
  readonly required: ReadonlySet<string>;
  readonly forbidden: readonly RegExp[];
}

const policies: Readonly<Record<string, ManifestPolicy>> = {
  'apps/site/package.json': {
    required: new Set([
      '@emotion/cache',
      '@emotion/react',
      '@emotion/styled',
      '@mui/material',
      '@mui/material-nextjs',
      '@reduxjs/toolkit',
      'next',
      'react',
      'react-dom',
      'react-redux',
    ]),
    forbidden: [
      /^@apollo\/client$/,
      /^@chakra-ui\//,
      /^@mantine\//,
      /^@remix-run\//,
      /^@tanstack\/react-query$/,
      /^@vitejs\//,
      /^antd$/,
      /^astro$/,
      /^axios$/,
      /^ky$/,
      /^react-router(?:-dom)?$/,
      /^styled-components$/,
      /^swr$/,
      /^tailwindcss$/,
      /^vite$/,
      /^vue$/,
    ],
  },
  'services/server/package.json': {
    required: new Set(['@fastify/swagger', 'fastify']),
    forbidden: [/^@nestjs\//, /^express$/, /^hono$/, /^koa$/],
  },
};

export function inspectStackManifest(
  manifestPath: string,
  manifest: PackageManifest,
): readonly StackPolicyViolation[] {
  const policy = policies[manifestPath];
  if (policy === undefined) {
    return [];
  }

  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const missing: StackPolicyViolation[] = [...policy.required]
    .filter((packageName) => !dependencies.has(packageName))
    .map((packageName) => ({ kind: 'missing-dependency', manifest: manifestPath, packageName }));
  const forbidden: StackPolicyViolation[] = [...dependencies]
    .filter((packageName) => policy.forbidden.some((pattern) => pattern.test(packageName)))
    .sort()
    .map((packageName) => ({ kind: 'forbidden-dependency', manifest: manifestPath, packageName }));

  return [...missing, ...forbidden];
}

export async function inspectWorkspaceStack(
  root: string,
): Promise<readonly StackPolicyViolation[]> {
  const violations: StackPolicyViolation[] = [];

  for (const manifestPath of Object.keys(policies)) {
    const source = await readFile(resolve(root, manifestPath), 'utf8');
    const manifest: unknown = JSON.parse(source);
    if (!isPackageManifest(manifest)) {
      throw new Error(`${manifestPath} is not a package manifest`);
    }
    violations.push(...inspectStackManifest(manifestPath, manifest));
  }

  return violations;
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return typeof value === 'object' && value !== null;
}
