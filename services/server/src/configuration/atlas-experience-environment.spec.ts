import { describe, expect, it } from 'vitest';

import {
  AtlasExperienceConfigurationFailure,
  loadAtlasExperienceConfiguration,
} from './atlas-experience-environment.js';

const serverOnly = {
  DEVRANDOM_ATLAS_URI: 'mongodb+srv://private-user:private-password@cluster.mongodb.net/',
  DEVRANDOM_ATLAS_DATABASE: 'devrandom_e0',
  DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY: '/var/lib/devrandom/experience-model-cache',
};

describe('server-only Atlas Experience configuration', () => {
  it('disables Atlas when the server has no Atlas binding', () => {
    expect(loadAtlasExperienceConfiguration({})).toEqual({ kind: 'Disabled' });
  });

  it.each([
    serverOnly.DEVRANDOM_ATLAS_URI,
    'mongodb://private-user:private-password@cluster.mongodb.net:27017/?tls=true',
    'mongodb://private-user:private-password@host1.mongodb.net:27017,host2.mongodb.net:27017/?tls=true',
  ])('binds a separate Atlas client to the explicitly named database', (mongodbUri) => {
    expect(
      loadAtlasExperienceConfiguration({ ...serverOnly, DEVRANDOM_ATLAS_URI: mongodbUri }),
    ).toEqual({
      kind: 'Configured',
      mongodbUri,
      databaseName: 'devrandom_e0',
      modelCacheDirectory: '/var/lib/devrandom/experience-model-cache',
    });
  });

  it.each([
    { ...serverOnly, DEVRANDOM_ATLAS_DATABASE: undefined },
    { ...serverOnly, DEVRANDOM_ATLAS_DATABASE: 'admin/db' },
    { ...serverOnly, DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY: undefined },
    { ...serverOnly, DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY: 'relative/cache' },
    { ...serverOnly, DEVRANDOM_ATLAS_URI: 'https://cluster.mongodb.net/' },
    { ...serverOnly, DEVRANDOM_ATLAS_URI: 'mongodb+srv://cluster.mongodb.net:27017/' },
    { ...serverOnly, DEVRANDOM_ATLAS_URI: 'mongodb://cluster.mongodb.net:27017/' },
    { ...serverOnly, DEVRANDOM_ATLAS_URI: 'mongodb+srv://cluster.mongodb.net/?tls=false' },
  ])('rejects invalid Atlas settings without disclosing credentials', (environment) => {
    try {
      loadAtlasExperienceConfiguration(environment);
    } catch (cause) {
      expect(cause).toBeInstanceOf(AtlasExperienceConfigurationFailure);
      expect(String(cause)).not.toContain('private-user');
      expect(String(cause)).not.toContain('private-password');
      return;
    }
    throw new Error('invalid Atlas setting was accepted');
  });
});
