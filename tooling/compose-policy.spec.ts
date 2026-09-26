import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  promotionMandateSchemaSaid,
  taskMandateSchemaSaid,
} from '../packages/protocol/src/mandate/mandate-credential.js';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

interface ObjectValue {
  readonly [key: string]: unknown;
}

function objectValue(value: unknown, path: string): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain an object`);
  }

  return value as ObjectValue;
}

const externalImages = {
  keria:
    'weboftrust/keria:0.4.0@sha256:05c3e09444e7e0b8847ba07dab153d1c7d88086bf4f889c122fef96c959b9ed5',
  mongodb:
    'mongo:8.3.11-noble@sha256:02eb14a1130c6d060847c4169eccd4d79d9f172a584da7aea8f160c492537b02',
  witnesses:
    'weboftrust/keri:1.2.14@sha256:0d48184e58792ed4bdba8ece7e3eebdc4aad079dd25a77bd6d80e06664072990',
} as const;

describe('Compose integration boundary', () => {
  it('contains the complete identity journey with pinned external services and readiness gates', async () => {
    const { stdout } = await execFileAsync('docker', [
      'compose',
      '--env-file',
      '.env.example',
      'config',
      '--format',
      'json',
    ]);
    const config = objectValue(JSON.parse(stdout) as unknown, 'Compose config');
    const services = objectValue(config.services, 'Compose services');

    expect(Object.keys(services).sort()).toEqual([
      'keria',
      'mongodb',
      'server',
      'site',
      'witnesses',
    ]);

    for (const [name, image] of Object.entries(externalImages)) {
      const service = objectValue(services[name], `Compose service ${name}`);
      expect(service.image).toBe(image);
      expect(service.healthcheck).toBeDefined();
    }

    const mongodb = objectValue(services.mongodb, 'Compose service mongodb');
    expect(mongodb.command).toEqual(['mongod', '--bind_ip_all', '--replSet', 'devrandom-rs']);

    const server = objectValue(services.server, 'Compose service server');
    expect(server.build).toBeDefined();
    expect(server.healthcheck).toBeDefined();
    expect(objectValue(server.environment, 'server environment')).toMatchObject({
      DEVRANDOM_MONGODB_URI: 'mongodb://mongodb:27017/devrandom?replicaSet=devrandom-rs',
      DEVRANDOM_HOSTED_WORK_MONGODB_URI:
        'mongodb://mongodb:27017/devrandom_e0?replicaSet=devrandom-rs',
      DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS: '',
      DEVRANDOM_TASK_CURSOR_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL: `http://server:3211/oobi/${taskMandateSchemaSaid}`,
      DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL: `http://server:3211/oobi/${promotionMandateSchemaSaid}`,
    });

    const keria = objectValue(services.keria, 'Compose service keria');
    expect(keria.command).toEqual([
      'start',
      '--config-dir',
      '/keria/config',
      '--config-file',
      'keria',
      '--name',
      'keria',
    ]);
    expect(objectValue(keria.depends_on, 'KERIA dependencies')).toMatchObject({
      witnesses: { condition: 'service_healthy' },
    });
    expect(keria.entrypoint).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'cp /keria/config-source/keria.json /keria/config/keri/cf/keria.json',
        ),
      ]),
    );

    expect(objectValue(server.depends_on, 'server dependencies')).toMatchObject({
      keria: { condition: 'service_healthy' },
      mongodb: { condition: 'service_healthy' },
    });

    const site = objectValue(services.site, 'Compose service site');
    expect(site.build).toBeDefined();
    expect(site.healthcheck).toBeDefined();
    expect(objectValue(site.depends_on, 'site dependencies')).toMatchObject({
      server: { condition: 'service_healthy' },
    });

    const siteDockerfile = await readFile('apps/site/Dockerfile', 'utf8');
    expect(siteDockerfile).toContain(
      'nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284',
    );

    const witnesses = objectValue(services.witnesses, 'Compose service witnesses');
    if (!Array.isArray(witnesses.volumes)) {
      throw new Error('Compose witness volumes must contain an array');
    }
    const witnessConfigVolume = witnesses.volumes
      .map((volume, index) => objectValue(volume, `Compose witness volume ${String(index)}`))
      .find((volume) => volume.target === '/keripy/config-source');
    expect(witnessConfigVolume).toMatchObject({
      type: 'bind',
      target: '/keripy/config-source',
      read_only: true,
    });
    expect(witnesses.entrypoint).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cp /keripy/config-source/*.json /keripy/scripts/keri/cf/main/'),
      ]),
    );

    if (!Array.isArray(keria.volumes)) {
      throw new Error('Compose KERIA volumes must contain an array');
    }
    const keriaConfigVolume = keria.volumes
      .map((volume, index) => objectValue(volume, `Compose KERIA volume ${String(index)}`))
      .find((volume) => volume.target === '/keria/config-source/keria.json');
    expect(keriaConfigVolume).toMatchObject({
      type: 'bind',
      target: '/keria/config-source/keria.json',
      read_only: true,
    });

    const volumes = objectValue(config.volumes, 'Compose volumes');
    expect(Object.keys(volumes).sort()).toEqual(['keria-data', 'mongodb-data', 'witness-data']);
  });

  it('publishes safe example configuration without tracked credentials', async () => {
    const example = await readFile('.env.example', 'utf8');
    const gitignore = await readFile('.gitignore', 'utf8');
    const justfile = await readFile('justfile', 'utf8');

    expect(example).toContain('DEVRANDOM_COMPOSE_PROJECT=devrandom');
    expect(example).not.toMatch(/^(?:[^#\n]*)(?:PASSWORD|PRIVATE|SALT|SECRET|TOKEN|KEY)=/mu);
    expect(gitignore).toMatch(/^\.env$/mu);
    expect(justfile).toContain('atlas_env="${DEVRANDOM_ATLAS_ENV_FILE:-.env}"');
    expect(justfile).toContain('node --env-file="$atlas_env"');
    expect(justfile).not.toContain('source "$atlas_env"');
  });

  it('exposes one complete lifecycle and a bounded integration test', async () => {
    const { stdout } = await execFileAsync('just', ['--list']);
    const justfile = await readFile('justfile', 'utf8');
    const replicaSetScript = await readFile('tooling/mongodb-replica-set.ts', 'utf8');

    for (const command of [
      'integration-up',
      'integration-health',
      'integration-logs',
      'integration-reset',
      'integration-down',
      'down',
      'up',
      'test-mongodb-integration',
      'test-atlas-integration',
      'test-identity-integration',
      'test-identity-journey',
      'test-issuer-bootstrap-integration',
      'test-integration',
    ]) {
      expect(stdout).toContain(command);
    }
    expect(stdout).not.toContain('demo-up');
    expect(stdout).not.toContain('demo-down');

    const upStart = justfile.indexOf('\nup:') + 1;
    const downStart = justfile.indexOf('\ndown:', upStart) + 1;
    expect(upStart).toBeGreaterThan(-1);
    expect(downStart).toBeGreaterThan(upStart);
    const upRecipe = justfile.slice(upStart, downStart);
    expect(upRecipe).toContain('build server');
    expect(upRecipe).toContain('build site');
    expect(upRecipe).toContain('tooling/mongodb-replica-set.ts');
    expect(upRecipe).not.toContain('build server site');

    expect(justfile).toContain('packages/identity/src/e0/acdc.integration.spec.ts');
    expect(justfile).toContain(
      'services/server/src/task/infrastructure/mongo-tasks.integration.spec.ts',
    );
    expect(justfile).toContain('DEVRANDOM_WORK_READY_URL="http://$issuer_endpoint/ready/work"');
    expect(replicaSetScript).toContain('db.hello()');
    expect(replicaSetScript).toContain('hello.isWritablePrimary');
    expect(justfile).toContain('DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL="http://server:3211/oobi/');
    expect(justfile).toContain(
      'pnpm --filter @devrandom/identity exec node --input-type=module -e',
    );

    const mechanismStart = justfile.indexOf('test-integration:');
    const journeyStart = justfile.indexOf('test-identity-journey:');
    expect(mechanismStart).toBeGreaterThan(-1);
    expect(journeyStart).toBeGreaterThan(mechanismStart);
    const mechanismRecipe = justfile.slice(mechanismStart, journeyStart);
    expect(mechanismRecipe).not.toContain('build site');
    expect(mechanismRecipe).not.toContain('site\n');
    expect(mechanismRecipe).toContain('integration-health.ts mongodb witnesses keria server');
    expect(mechanismRecipe).toContain('integration-smoke.ts mechanism');
  });
});
