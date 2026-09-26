import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

export interface AtlasExperienceEnvironment {
  readonly DEVRANDOM_ATLAS_URI?: string | undefined;
  readonly DEVRANDOM_ATLAS_DATABASE?: string | undefined;
  readonly DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY?: string | undefined;
}

export type AtlasExperienceConfiguration =
  | { readonly kind: 'Disabled' }
  | {
      readonly kind: 'Configured';
      readonly mongodbUri: string;
      readonly databaseName: string;
      readonly modelCacheDirectory: string;
    };

type AtlasExperienceConfigurationError =
  'AtlasBindingInvalid' | 'AtlasDatabaseInvalid' | 'AtlasModelCacheInvalid';

export class AtlasExperienceConfigurationFailure extends Error {
  readonly detail: AtlasExperienceConfigurationError;

  constructor(detail: AtlasExperienceConfigurationError) {
    super(`Server Atlas Experience configuration is invalid: ${detail}`);
    this.name = 'AtlasExperienceConfigurationFailure';
    this.detail = detail;
  }
}

/** Atlas credentials stay in the server environment, never the CLI or a worker. */
export function loadAtlasExperienceConfiguration(
  environment: AtlasExperienceEnvironment,
): AtlasExperienceConfiguration {
  const mongodbUri = environment.DEVRANDOM_ATLAS_URI;
  if (mongodbUri === undefined || mongodbUri.length === 0) return { kind: 'Disabled' };

  const databaseName = environment.DEVRANDOM_ATLAS_DATABASE;
  if (
    databaseName === undefined ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(databaseName) ||
    ['admin', 'config', 'local'].includes(databaseName)
  )
    throw new AtlasExperienceConfigurationFailure('AtlasDatabaseInvalid');

  let uri: URL;
  try {
    if (mongodbUri.startsWith('mongodb://')) {
      const remainder = mongodbUri.slice('mongodb://'.length);
      const slash = remainder.indexOf('/');
      if (slash < 1) throw new Error('missing authority');
      const authority = remainder.slice(0, slash);
      const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',');
      if (
        hosts.length === 0 ||
        !hosts.every((host) => /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(host))
      )
        throw new Error('invalid host list');
      uri = new URL(`mongodb://placeholder${remainder.slice(slash)}`);
    } else {
      uri = new URL(mongodbUri);
    }
  } catch {
    throw new AtlasExperienceConfigurationFailure('AtlasBindingInvalid');
  }
  const tls = uri.searchParams.getAll('tls');
  const ssl = uri.searchParams.getAll('ssl');
  const tlsDisabled = tls.includes('false') || ssl.includes('false');
  const standardUriSecure =
    (tls.length === 1 && tls[0] === 'true' && ssl.length === 0) ||
    (ssl.length === 1 && ssl[0] === 'true' && tls.length === 0);
  if (
    (uri.protocol !== 'mongodb:' && uri.protocol !== 'mongodb+srv:') ||
    uri.hostname.length === 0 ||
    uri.hash.length > 0 ||
    (uri.pathname !== '/' && uri.pathname !== `/${databaseName}`) ||
    (uri.protocol === 'mongodb+srv:' && uri.port.length > 0) ||
    tlsDisabled ||
    (uri.protocol === 'mongodb:' && !standardUriSecure)
  )
    throw new AtlasExperienceConfigurationFailure('AtlasBindingInvalid');

  const modelCacheDirectory = environment.DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY;
  if (
    modelCacheDirectory === undefined ||
    !isAbsolute(modelCacheDirectory) ||
    normalize(modelCacheDirectory) === '/' ||
    modelCacheDirectory.includes('\0')
  )
    throw new AtlasExperienceConfigurationFailure('AtlasModelCacheInvalid');

  return { kind: 'Configured', mongodbUri, databaseName, modelCacheDirectory };
}

/** Check the server-only model cache before an Atlas-capable server is composed. */
export async function verifyAtlasExperienceModelCache(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const cache = await lstat(directory);
    if (!cache.isDirectory() || cache.isSymbolicLink() || (cache.mode & 0o777) !== 0o700)
      throw new Error('nonprivate cache');
  } catch {
    throw new AtlasExperienceConfigurationFailure('AtlasModelCacheInvalid');
  }
}
