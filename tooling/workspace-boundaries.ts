import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const deployableNames = new Set(['@devrandom/cli', '@devrandom/issuer', '@devrandom/site']);

const workspaceDirectories = [
  'apps/cli',
  'apps/site',
  'packages/domain',
  'packages/identity',
  'packages/protocol',
  'packages/runtime',
  'packages/storage',
  'services/issuer',
] as const;

export interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
}

export type WorkspaceBoundaryViolation =
  | {
      readonly kind: 'deployable-imports-deployable';
      readonly source: string;
      readonly target: string;
    }
  | {
      readonly kind: 'package-imports-deployable';
      readonly source: string;
      readonly target: string;
    };

interface ObjectValue {
  readonly [key: string]: unknown;
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireName(manifest: ObjectValue, path: string): string {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`${path} must contain a non-empty package name`);
  }

  return manifest.name;
}

function dependencyNames(manifest: ObjectValue, path: string): ReadonlySet<string> {
  const names = new Set<string>();

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const value = manifest[field];
    if (value === undefined) {
      continue;
    }
    if (!isObject(value)) {
      throw new Error(`${path} field ${field} must be an object`);
    }

    for (const dependency of Object.keys(value)) {
      names.add(dependency);
    }
  }

  return names;
}

export async function loadWorkspace(root: string): Promise<readonly WorkspacePackage[]> {
  return Promise.all(
    workspaceDirectories.map(async (directory) => {
      const path = resolve(root, directory, 'package.json');
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isObject(parsed)) {
        throw new Error(`${path} must contain a JSON object`);
      }

      return {
        directory,
        name: requireName(parsed, path),
        dependencies: dependencyNames(parsed, path),
      };
    }),
  );
}

export function findWorkspaceBoundaryViolations(
  workspace: readonly WorkspacePackage[],
): readonly WorkspaceBoundaryViolation[] {
  const workspaceNames = new Set(workspace.map(({ name }) => name));
  const violations: WorkspaceBoundaryViolation[] = [];

  for (const source of workspace) {
    const sourceIsDeployable = deployableNames.has(source.name);

    for (const target of source.dependencies) {
      if (!workspaceNames.has(target) || !deployableNames.has(target)) {
        continue;
      }

      violations.push({
        kind: sourceIsDeployable ? 'deployable-imports-deployable' : 'package-imports-deployable',
        source: source.name,
        target,
      });
    }
  }

  return violations;
}
