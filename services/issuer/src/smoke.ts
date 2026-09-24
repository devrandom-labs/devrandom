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
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/health`);
  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(`issuer health returned ${String(response.status)}`);
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('service' in body) ||
    body.service !== 'issuer' ||
    !('status' in body) ||
    body.status !== 'ready'
  ) {
    throw new Error('issuer health returned an unexpected body');
  }
} finally {
  await server.close();
}
