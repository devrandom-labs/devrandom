import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { verifiedIssuerFixture } from '../test/verified-issuer-fixture.js';
import { registrationRoutesFixture } from '../test/registration-routes-fixture.js';
import { buildIssuerServer } from './route/issuer-server.js';
import { issuerReadinessFixture } from '../test/issuer-readiness-fixture.js';

const server = buildIssuerServer(
  verifiedIssuerFixture(),
  registrationRoutesFixture(),
  issuerReadinessFixture(),
);

try {
  await server.ready();
  const destination = resolve(import.meta.dirname, '..', 'openapi.json');
  await writeFile(destination, `${JSON.stringify(server.swagger(), undefined, 2)}\n`);
} finally {
  await server.close();
}
