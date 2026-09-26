import { describe, expect, it } from 'vitest';

import { inspectStackManifest, type PackageManifest } from './stack-policy.js';

describe('stack policy', () => {
  it('requires the selected browser and service stack', () => {
    const site: PackageManifest = {
      dependencies: {
        '@emotion/cache': '11.14.0',
        '@emotion/react': '11.14.0',
        '@emotion/styled': '11.14.1',
        '@mui/material': '9.4.0',
        '@mui/material-nextjs': '9.4.0',
        '@reduxjs/toolkit': '2.9.0',
        next: '16.3.6',
        react: '19.3.0',
        'react-dom': '19.3.0',
        'react-redux': '9.3.0',
      },
    };
    const server: PackageManifest = {
      dependencies: {
        '@fastify/swagger': '9.6.1',
        fastify: '5.12.5',
      },
    };

    expect(inspectStackManifest('apps/site/package.json', site)).toEqual([]);
    expect(inspectStackManifest('services/server/package.json', server)).toEqual([]);
  });

  it('rejects competing libraries even when the selected stack is present', () => {
    const site: PackageManifest = {
      dependencies: {
        '@chakra-ui/react': '3.0.0',
        '@emotion/cache': '11.14.0',
        '@emotion/react': '11.14.0',
        '@emotion/styled': '11.14.1',
        '@mui/material': '9.4.0',
        '@mui/material-nextjs': '9.4.0',
        '@reduxjs/toolkit': '2.9.0',
        next: '16.3.6',
        react: '19.3.0',
        'react-dom': '19.3.0',
        'react-redux': '9.3.0',
      },
      devDependencies: {
        vite: '8.3.0',
      },
    };
    const server: PackageManifest = {
      dependencies: {
        '@fastify/swagger': '9.6.1',
        '@nestjs/core': '11.0.0',
        fastify: '5.12.5',
      },
    };

    expect(inspectStackManifest('apps/site/package.json', site)).toEqual([
      {
        kind: 'forbidden-dependency',
        manifest: 'apps/site/package.json',
        packageName: '@chakra-ui/react',
      },
      {
        kind: 'forbidden-dependency',
        manifest: 'apps/site/package.json',
        packageName: 'vite',
      },
    ]);
    expect(inspectStackManifest('services/server/package.json', server)).toEqual([
      {
        kind: 'forbidden-dependency',
        manifest: 'services/server/package.json',
        packageName: '@nestjs/core',
      },
    ]);
  });
});
