import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { verifiedIssuerFixture } from '../test/verified-issuer-fixture.js';
import { registrationRoutesFixture } from '../test/registration-routes-fixture.js';
import { buildDevrandomServer } from './server.js';
import { issuerReadinessFixture } from '../test/issuer-readiness-fixture.js';

const server = buildDevrandomServer(
  verifiedIssuerFixture(),
  registrationRoutesFixture(),
  issuerReadinessFixture(),
  { verify: () => Promise.resolve() },
);

try {
  await server.ready();
  const destination = resolve(import.meta.dirname, '..', 'openapi.json');
  await writeFile(destination, `${JSON.stringify(server.swagger(), undefined, 2)}\n`);
} finally {
  await server.close();
}
