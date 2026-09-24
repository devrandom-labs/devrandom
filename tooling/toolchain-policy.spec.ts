import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface ObjectValue {
  readonly [key: string]: unknown;
}

function objectValue(value: unknown, path: string): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain an object`);
  }

  return value as ObjectValue;
}

const selectedDevDependencies = {
  '@eslint/js': '10.0.1',
  '@types/node': '24.13.6',
  eslint: '10.11.0',
  prettier: '3.9.9',
  tsx: '4.23.15',
  typescript: '6.0.3',
  'typescript-eslint': '8.70.1',
  vite: '8.3.0',
  vitest: '5.0.1',
} as const;

describe('toolchain policy', () => {
  it('pins the exact Nix runtime and compatible JavaScript toolchain', async () => {
    const manifestSource = await readFile('package.json', 'utf8');
    const manifest: unknown = JSON.parse(manifestSource);
    const manifestObject = objectValue(manifest, 'package.json');
    const engines = objectValue(manifestObject.engines, 'package.json engines');
    const devDependencies = objectValue(
      manifestObject.devDependencies,
      'package.json devDependencies',
    );
    const flake = await readFile('flake.nix', 'utf8');
    const workspace = await readFile('pnpm-workspace.yaml', 'utf8');

    expect(manifestObject.packageManager).toBe('pnpm@12.3.4');
    expect(engines.node).toBe('24.20.0');
    expect(engines.pnpm).toBe('12.3.4');
    expect(devDependencies).toMatchObject(selectedDevDependencies);
    expect(flake).toContain(
      'nixpkgs.url = "github:NixOS/nixpkgs/b6c98e9e6633ee64753b594ff4a5febf0367fc00";',
    );
    expect(flake).toContain('pnpm = pkgs.pnpm_12;');
    expect(flake).toContain('colima = pkgs.colima;');
    expect(flake).toContain('assert node.version == "24.20.0";');
    expect(flake).toContain('assert pnpm.version == "12.3.4";');
    expect(flake).toContain('assert colima.version == "0.10.3";');
    expect(workspace).toContain(
      "allowBuilds:\n  '@google/genai': false\n  esbuild: true\n  protobufjs: false",
    );
    expect(workspace).toContain('pmOnFail: ignore');
    expect(workspace).toContain('minimumReleaseAgeStrict: true');
  });
});
