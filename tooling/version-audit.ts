import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ImageReference {
  readonly digest: string;
  readonly repository: string;
  readonly source: string;
  readonly tag: string;
}

interface RegistryPolicy {
  readonly stableTag: RegExp;
  readonly tagQuery: string;
}

interface ObjectValue {
  readonly [key: string]: unknown;
}

const registryPolicies: Readonly<Record<string, RegistryPolicy>> = {
  'library/mongo': {
    stableTag: /^(\d+)\.(\d+)\.(\d+)-noble$/u,
    tagQuery: 'noble',
  },
  'library/node': {
    stableTag: /^(24)\.(\d+)\.(\d+)-bookworm-slim$/u,
    tagQuery: '24.',
  },
  'weboftrust/keri': {
    stableTag: /^(\d+)\.(\d+)\.(\d+)$/u,
    tagQuery: '',
  },
  'weboftrust/keria': {
    stableTag: /^(\d+)\.(\d+)\.(\d+)$/u,
    tagQuery: '',
  },
};

const ignoredDirectories = new Set([
  '.direnv',
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);

function objectValue(value: unknown, path: string): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain an object`);
  }

  return value as ObjectValue;
}

function commandExit(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      reject(new Error(`${command} ended from signal ${signal ?? 'unknown'}`));
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function commandOutput(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }

      reject(
        new Error(
          `${command} failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${String(code)}`}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      );
    });
  });
}

function imageReference(source: string): ImageReference {
  const digestSeparator = source.lastIndexOf('@sha256:');
  if (digestSeparator < 0) {
    throw new Error(`container image is not digest-pinned: ${source}`);
  }

  const namedReference = source.slice(0, digestSeparator);
  const digest = source.slice(digestSeparator + 1);
  const lastSlash = namedReference.lastIndexOf('/');
  const tagSeparator = namedReference.lastIndexOf(':');
  if (tagSeparator <= lastSlash) {
    throw new Error(`container image is not version-tagged: ${source}`);
  }

  const unqualifiedRepository = namedReference.slice(0, tagSeparator);
  const repository = unqualifiedRepository.includes('/')
    ? unqualifiedRepository
    : `library/${unqualifiedRepository}`;
  const tag = namedReference.slice(tagSeparator + 1);

  if (!/^sha256:[a-f\d]{64}$/u.test(digest)) {
    throw new Error(`container image has an invalid digest: ${source}`);
  }

  return { digest, repository, source, tag };
}

async function dockerfilesUnder(directory: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      paths.push(...(await dockerfilesUnder(join(directory, entry.name))));
    } else if (entry.isFile() && entry.name.startsWith('Dockerfile')) {
      paths.push(join(directory, entry.name));
    }
  }

  return paths;
}

async function configuredImages(): Promise<readonly ImageReference[]> {
  const renderedSource = await commandOutput('docker', [
    'compose',
    '--env-file',
    '.env.example',
    'config',
    '--format',
    'json',
  ]);
  const rendered = objectValue(JSON.parse(renderedSource) as unknown, 'Compose config');
  const services = objectValue(rendered.services, 'Compose services');
  const references: ImageReference[] = [];

  for (const [name, value] of Object.entries(services)) {
    const service = objectValue(value, `Compose service ${name}`);
    if (service.build === undefined) {
      if (typeof service.image !== 'string') {
        throw new Error(`external Compose service ${name} has no image`);
      }

      references.push(imageReference(service.image));
    }
  }

  for (const dockerfile of await dockerfilesUnder('.')) {
    const source = await readFile(dockerfile, 'utf8');
    const baseImages = source.matchAll(/^FROM(?:\s+--platform=\S+)?\s+(\S+)/gimu);
    for (const match of baseImages) {
      const baseImage = match[1];
      if (baseImage === undefined || baseImage === 'scratch') {
        continue;
      }

      references.push(imageReference(baseImage));
    }
  }

  return [...new Map(references.map((reference) => [reference.source, reference])).values()];
}

async function registryDigest(reference: ImageReference): Promise<string> {
  const authorizationUrl = new URL('https://auth.docker.io/token');
  authorizationUrl.searchParams.set('service', 'registry.docker.io');
  authorizationUrl.searchParams.set('scope', `repository:${reference.repository}:pull`);
  const authorizationResponse = await fetch(authorizationUrl);
  if (!authorizationResponse.ok) {
    throw new Error(
      `Docker Hub authorization failed for ${reference.repository}: ${String(authorizationResponse.status)}`,
    );
  }

  const authorization = objectValue(
    (await authorizationResponse.json()) as unknown,
    'Docker Hub authorization',
  );
  if (typeof authorization.token !== 'string') {
    throw new Error('Docker Hub authorization response has no token');
  }

  const manifestResponse = await fetch(
    `https://registry-1.docker.io/v2/${reference.repository}/manifests/${reference.tag}`,
    {
      method: 'HEAD',
      headers: {
        accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(', '),
        authorization: `Bearer ${authorization.token}`,
      },
    },
  );
  if (!manifestResponse.ok) {
    throw new Error(
      `Docker Hub manifest lookup failed for ${reference.repository}:${reference.tag}: ${String(manifestResponse.status)}`,
    );
  }

  const digest = manifestResponse.headers.get('docker-content-digest');
  if (digest === null) {
    throw new Error(`Docker Hub returned no digest for ${reference.repository}:${reference.tag}`);
  }

  return digest;
}

function versionFromTag(tag: string, policy: RegistryPolicy): readonly number[] | undefined {
  const match = policy.stableTag.exec(tag);
  if (match === null) {
    return undefined;
  }

  return match.slice(1).map((part) => Number(part));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

async function latestStableTag(repository: string, policy: RegistryPolicy): Promise<string> {
  const firstPage = new URL(`https://hub.docker.com/v2/repositories/${repository}/tags`);
  firstPage.searchParams.set('page_size', '100');
  if (policy.tagQuery.length > 0) {
    firstPage.searchParams.set('name', policy.tagQuery);
  }

  const stableTags: { readonly name: string; readonly version: readonly number[] }[] = [];
  let pageUrl: string | undefined = firstPage.toString();
  while (pageUrl !== undefined) {
    const response = await fetch(pageUrl);
    if (!response.ok) {
      throw new Error(`Docker Hub tag lookup failed for ${repository}: ${String(response.status)}`);
    }

    const page = objectValue((await response.json()) as unknown, 'Docker Hub tags page');
    if (!Array.isArray(page.results)) {
      throw new Error('Docker Hub tags page has no results array');
    }

    for (const value of page.results) {
      const tag = objectValue(value, 'Docker Hub tag');
      if (typeof tag.name !== 'string') {
        throw new Error('Docker Hub tag has no name');
      }

      const version = versionFromTag(tag.name, policy);
      if (version !== undefined) {
        stableTags.push({ name: tag.name, version });
      }
    }

    if (page.next === null) {
      pageUrl = undefined;
    } else if (typeof page.next === 'string') {
      pageUrl = page.next;
    } else {
      throw new Error('Docker Hub tags page has an invalid next link');
    }
  }

  const latest = stableTags.sort((left, right) => compareVersions(right.version, left.version))[0];
  if (latest === undefined) {
    throw new Error(`Docker Hub has no stable tags matching policy for ${repository}`);
  }

  return latest.name;
}

console.log('JavaScript dependency updates:');
const dependencyExit = await commandExit('pnpm', ['outdated', '--format', 'json']);
if (dependencyExit !== 0 && dependencyExit !== 1) {
  throw new Error(`pnpm outdated failed with exit code ${String(dependencyExit)}`);
}

if (!(await pathExists('compose.yaml'))) {
  console.log('Container image updates: NOT CONFIGURED (no Compose manifest exists yet)');
} else {
  console.log('Container image integrity and stable-tag updates:');
  for (const reference of await configuredImages()) {
    const policy = registryPolicies[reference.repository];
    if (policy === undefined) {
      throw new Error(`no stable-tag policy exists for ${reference.repository}`);
    }

    const publishedDigest = await registryDigest(reference);
    if (publishedDigest !== reference.digest) {
      throw new Error(
        `${reference.repository}:${reference.tag} digest mismatch: selected ${reference.digest}, registry ${publishedDigest}`,
      );
    }

    const latestTag = await latestStableTag(reference.repository, policy);
    const freshness = latestTag === reference.tag ? 'current' : `newer stable tag ${latestTag}`;
    console.log(`- ${reference.source}: digest verified; ${freshness}`);
  }
}
