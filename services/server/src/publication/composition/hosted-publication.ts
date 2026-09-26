import { createHash } from 'node:crypto';
import type { HarnessPublicationSignatures } from '@devrandom/identity';
import type { Db, MongoClient } from 'mongodb';
import {
  publishHarness,
  type PublicationAdmissionDependencies,
} from '../application/publish-harness.js';
import { MongoHarnessPublications } from '../infrastructure/mongo-harness-publications.js';
import type { PublicationRoutesConfiguration } from '../route/publication-routes.js';
export function hostedHarnessPublication(input: {
  readonly client: MongoClient;
  readonly database: Db;
  readonly signatures: Pick<HarnessPublicationSignatures, 'verify'>;
  readonly activation: PublicationAdmissionDependencies['activation'];
}): PublicationRoutesConfiguration['publication'] {
  const storage = new MongoHarnessPublications(input.client, input.database);
  const dependencies: PublicationAdmissionDependencies = {
    activation: input.activation,
    signatures: input.signatures,
    storage,
    fingerprint: (command) =>
      `sha256:${createHash('sha256').update(JSON.stringify(command)).digest('hex')}`,
  };
  return {
    publish: (command) => publishHarness(command, dependencies),
    read: (packageSaid) => storage.read(packageSaid),
  };
}
