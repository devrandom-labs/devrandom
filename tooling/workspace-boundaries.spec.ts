import { describe, expect, it } from 'vitest';
import {
  findWorkspaceBoundaryViolations,
  loadWorkspace,
  type WorkspacePackage,
} from './workspace-boundaries.js';

function workspacePackage(name: string, dependencies: readonly string[] = []): WorkspacePackage {
  return {
    directory: name,
    name,
    dependencies: new Set(dependencies),
  };
}

describe('workspace boundaries', () => {
  it('accepts the repository package graph', async () => {
    const workspace = await loadWorkspace(process.cwd());

    expect(findWorkspaceBoundaryViolations(workspace)).toEqual([]);
  });

  it('rejects dependencies between deployable applications and services', () => {
    const workspace = [
      workspacePackage('@devrandom/cli', ['@devrandom/issuer']),
      workspacePackage('@devrandom/issuer'),
    ];

    expect(findWorkspaceBoundaryViolations(workspace)).toEqual([
      {
        kind: 'deployable-imports-deployable',
        source: '@devrandom/cli',
        target: '@devrandom/issuer',
      },
    ]);
  });

  it('rejects package-to-deployable dependencies', () => {
    const workspace = [
      workspacePackage('@devrandom/domain', ['@devrandom/site']),
      workspacePackage('@devrandom/site'),
    ];

    expect(findWorkspaceBoundaryViolations(workspace)).toEqual([
      {
        kind: 'package-imports-deployable',
        source: '@devrandom/domain',
        target: '@devrandom/site',
      },
    ]);
  });
});
